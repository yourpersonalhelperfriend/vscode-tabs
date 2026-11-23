// Starts and stops one local `code serve-web` process.
//
// The connection token is generated here, handed to the CLI through a 0600
// file (so it never shows up in `ps`), and scrubbed from everything the CLI
// prints before it reaches our log file.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export type ServerStatus =
  | { kind: 'starting' }
  | { kind: 'downloading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const READY_TIMEOUT_MS = 10 * 60 * 1000; // first run downloads the server

export class CodeServer extends EventEmitter {
  readonly token = randomBytes(32).toString('hex');
  port = 0;
  status: ServerStatus = { kind: 'starting' };

  private proc: ChildProcess | null = null;
  private tokenDir: string | null = null;
  private stopping = false;
  private log: fs.WriteStream;

  constructor(private readonly codeBin: string, logFile: string) {
    super();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.log = fs.createWriteStream(logFile, { flags: 'w', mode: 0o600 });
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** URL for a tab. The token goes in the query once; serve-web turns it into a cookie and redirects. */
  url(query: string): string {
    const q = query ? `&${query}` : '';
    return `${this.origin}/?tkn=${this.token}${q}`;
  }

  isOwnUrl(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  async start(homePort?: number): Promise<void> {
    this.port = await pickPort(homePort);
    if (homePort && this.port !== homePort) {
      this.writeLog(`[vscode-tabs] port ${homePort} is busy; using ${this.port} for this run (VS Code settings and state from the usual port are not visible in this run)\n`);
    }

    const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    removeStaleTokenDirs(base);
    this.tokenDir = fs.mkdtempSync(path.join(base, 'vscode-tabs-'));
    fs.chmodSync(this.tokenDir, 0o700);
    const tokenFile = path.join(this.tokenDir, 'token');
    fs.writeFileSync(tokenFile, this.token, { mode: 0o600 });

    const args = [
      'serve-web',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--connection-token-file', tokenFile,
      '--accept-server-license-terms',
    ];
    this.writeLog(`$ ${path.basename(this.codeBin)} ${args.join(' ')}\n`);

    // Run the CLI under a small sh that owns a process group and tears it
    // down when our end of its stdin closes, so the server never outlives us,
    // even if Electron crashes.
    const proc = spawn('/bin/sh', ['-c', WATCHDOG, 'vscode-tabs-server', this.codeBin, ...args], {
      detached: true, // own process group, so stop() can take the whole tree down
      stdio: ['pipe', 'pipe', 'pipe'],
      env: serverEnv(),
    });
    this.proc = proc;
    this.pipe(proc.stdout!);
    this.pipe(proc.stderr!);
    proc.on('error', (err) => this.fail(`could not start ${this.codeBin}: ${err.message}`));
    proc.on('exit', (code, signal) => {
      this.writeLog(`\n[vscode-tabs] server exited (code ${code}, signal ${signal})\n`);
      this.proc = null;
      if (!this.stopping) this.fail(`code serve-web exited (code ${code ?? signal})`);
    });

    await this.waitReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (proc && proc.pid) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      killGroup(proc.pid, 'SIGTERM');
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000));
      if ((await Promise.race([exited, timeout])) === 'timeout') killGroup(proc.pid, 'SIGKILL');
    }
    this.cleanup();
  }

  /** Last-resort synchronous cleanup for process exit. */
  stopSync(): void {
    this.stopping = true;
    if (this.proc?.pid) killGroup(this.proc.pid, 'SIGTERM');
    this.cleanup();
  }

  private cleanup(): void {
    if (this.tokenDir) {
      fs.rmSync(this.tokenDir, { recursive: true, force: true });
      this.tokenDir = null;
    }
  }

  private setStatus(s: ServerStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private fail(message: string): void {
    if (this.status.kind === 'error') return;
    this.setStatus({ kind: 'error', message });
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.status.kind === 'error') return;
      const code = await probe(this.url(''));
      // 302: token accepted, server up. 202: the CLI is still downloading/starting the server.
      if (code === 302 || code === 200) {
        this.setStatus({ kind: 'ready' });
        return;
      }
      if (code === 202 && this.status.kind !== 'downloading') this.setStatus({ kind: 'downloading' });
      await sleep(500);
    }
    this.fail('timed out waiting for code serve-web');
  }

  private pipe(stream: NodeJS.ReadableStream): void {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) this.writeLog(line + '\n');
    });
    stream.on('end', () => rest && this.writeLog(rest + '\n'));
  }

  private writeLog(text: string): void {
    this.log.write(text.split(this.token).join('<token>').replace(/tkn=[^\s&]*/g, 'tkn=<token>'));
  }
}

const WATCHDOG = `
exec 3<&0
"$@" </dev/null 3<&- &
child=$!
{ while read -r _ <&3; do :; done; kill -TERM -- -$$; } &
wait "$child"
kill -TERM -- -$$
`;

function serverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Don't leak Electron's own variables into the server (and from there into terminals).
  for (const k of Object.keys(env)) {
    if (k.startsWith('ELECTRON_') || k.startsWith('CHROME_') || k === 'ORIGINAL_XDG_CURRENT_DESKTOP') delete env[k];
  }
  return env;
}

/** Token dirs left behind by a crashed run. Only one instance runs at a time, so any old one is stale. */
function removeStaleTokenDirs(base: string): void {
  try {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith('vscode-tabs-')) continue;
      const p = path.join(base, name);
      if (fs.lstatSync(p).uid === process.getuid?.()) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

function probe(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

/**
 * VS Code web keeps settings, keybindings, UI state and unsaved-file backups
 * in browser storage, which belongs to the origin, port included. So the app
 * keeps one "home" port: picked at random once (below the usual ephemeral
 * range), saved, and reused. If it is taken, this run uses another port.
 */
async function pickPort(home?: number): Promise<number> {
  if (home && (await tryListen(home))) return home;
  for (let i = 0; i < 50; i++) {
    const p = await tryListen(20000 + Math.floor(Math.random() * 12000));
    if (p) return p;
  }
  const p = await tryListen(0);
  if (!p) throw new Error('no free port on 127.0.0.1');
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** VSCODE_TABS_CODE, then `code` on PATH, then a fallback baked in by the Nix package. */
export function findCodeCli(): string | null {
  if (process.env.VSCODE_TABS_CODE) return process.env.VSCODE_TABS_CODE;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'code');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return process.env.VSCODE_TABS_CODE_FALLBACK || null;
}
