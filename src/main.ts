// vscode-tabs: one window, a tab bar, and one VS Code (served by `code serve-web`) per tab.

import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell,
  WebContentsView,
  type WebContents,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeServer, findCodeCli, type ServerStatus } from './server';
import { loadState, saveState, stateDir, type SavedTab, type State, type TabKind } from './state';

const BAR_HEIGHT = 34;
const LOG_FILE = path.join(stateDir, 'server.log');

interface Tab {
  id: number;
  kind: TabKind;
  path: string | null;
  view: WebContentsView;
  loaded: boolean;
  loading: boolean;
  pageTitle: string;
  /** Set while we wait to learn whether VS Code lets this tab close. */
  onCloseCancelled?: () => void;
}

app.setName('vscode-tabs');
app.setDesktopName('vscode-tabs.desktop');

// Second launch (`vscode-tabs ~/src/foo`) hands its folders to the running window.
// argv is [electron, ...chromium switches, appDir, ...our args].
const cliArgs = (() => {
  const raw = process.argv.slice(1);
  const i = raw.findIndex((a) => path.resolve(a) === app.getAppPath());
  return (i >= 0 ? raw.slice(i + 1) : raw).filter((a) => !a.startsWith('-'));
})();
if (!app.requestSingleInstanceLock({ args: cliArgs, cwd: process.cwd() })) {
  app.exit(0);
}

let win: BaseWindow;
let bar: WebContentsView;
let server: CodeServer | null = null;
let serverStatus: ServerStatus = { kind: 'starting' };
let tabs: Tab[] = [];
let activeId: number | null = null;
let nextId = 1;
let quitting = false;
let htmlFullscreen = false;
const state = loadState();

// ---------------------------------------------------------------- tabs

function labelOf(t: { kind: TabKind; path: string | null; pageTitle?: string }): string {
  if (t.kind === 'folder' && t.path) return path.basename(t.path) || t.path;
  if (t.kind === 'workspace' && t.path) return path.basename(t.path).replace(/\.code-workspace$/, '');
  return 'New Tab';
}

function queryOf(t: { kind: TabKind; path: string | null }): string {
  if (t.kind === 'folder' && t.path) return `folder=${encodeURIComponent(t.path)}`;
  if (t.kind === 'workspace' && t.path) return `workspace=${encodeURIComponent(t.path)}`;
  return 'ew=true'; // empty window
}

/** Read folder/workspace back out of a serve-web URL. Values are plain paths or vscode-remote:// URIs. */
function specFromUrl(url: string): SavedTab {
  const toPath = (v: string): string => {
    if (/^[a-z][\w+.-]*:\/\//i.test(v)) {
      try {
        return decodeURIComponent(new URL(v).pathname);
      } catch {
        return v;
      }
    }
    return v;
  };
  try {
    const q = new URL(url).searchParams;
    const folder = q.get('folder');
    if (folder) return { kind: 'folder', path: toPath(folder) };
    const ws = q.get('workspace');
    if (ws) return { kind: 'workspace', path: toPath(ws) };
  } catch {
    /* fall through */
  }
  return { kind: 'empty', path: null };
}

function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId);
}

function createTab(spec: SavedTab, opts: { index?: number; activate?: boolean; url?: string } = {}): Tab {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-vscode.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff');
  view.setVisible(false);
  const tab: Tab = { id: nextId++, kind: spec.kind, path: spec.path, view, loaded: false, loading: false, pageTitle: '' };
  const wc = view.webContents;

  installKeys(wc);
  wc.setWindowOpenHandler(({ url }) => {
    if (server?.isOwnUrl(url)) {
      // "New Window" etc. inside VS Code: open it as a tab instead.
      createTab(specFromUrl(url), { activate: true, url });
    } else {
      openExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!server?.isOwnUrl(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  const onNavigate = (_e: unknown, url: string) => {
    if (!server?.isOwnUrl(url)) return;
    const s = specFromUrl(url);
    if (s.kind !== tab.kind || s.path !== tab.path) {
      tab.kind = s.kind;
      tab.path = s.path;
      changed();
    }
  };
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', onNavigate);
  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    tab.pageTitle = title;
    if (tab.id === activeId) win.setTitle(title);
    pushState();
  });
  wc.on('did-start-loading', () => {
    tab.loading = true;
    pushState();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    pushState();
  });
  wc.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `“${labelOf(tab)}” may have unsaved changes.`,
      detail: 'VS Code asked to keep this tab open.',
    });
    if (choice === 0) e.preventDefault();
    else tab.onCloseCancelled?.();
  });
  wc.on('enter-html-full-screen', () => {
    htmlFullscreen = true;
    win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
    win.setFullScreen(false);
    layout();
  });
  wc.once('destroyed', () => removeTab(tab));
  if (opts.url) {
    tab.loaded = true;
    wc.loadURL(opts.url);
  }

  win.contentView.addChildView(view);
  const index = opts.index ?? tabs.length;
  tabs.splice(index, 0, tab);
  if (opts.activate || activeId === null) activate(tab.id);
  else changed();
  return tab;
}

function ensureLoaded(tab: Tab): void {
  if (tab.loaded || !server || serverStatus.kind !== 'ready') return;
  tab.loaded = true;
  tab.view.webContents.loadURL(server.url(queryOf(tab)));
}

function activate(id: number): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  ensureLoaded(tab);
  win.setTitle(tab.pageTitle || labelOf(tab));
  layout();
  tab.view.webContents.focus();
  changed();
}

function removeTab(tab: Tab): void {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
  if (quitting) return;
  if (activeId === tab.id) {
    activeId = null;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next.id);
    else {
      win.setTitle('VS Code Tabs');
      layout();
      bar.webContents.focus();
    }
  }
  changed();
}

/** Ask VS Code to close (it may veto via beforeunload). Resolves true once the tab is gone. */
function tryClose(tab: Tab): Promise<boolean> {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return Promise.resolve(true);
  if (!tab.loaded) {
    wc.close();
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    tab.onCloseCancelled = () => {
      tab.onCloseCancelled = undefined;
      resolve(false);
    };
    wc.once('destroyed', () => resolve(true));
    wc.close({ waitForBeforeUnload: true });
  });
}

function cycle(delta: number): void {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activate(tabs[(i + delta + tabs.length) % tabs.length].id);
}

function jump(n: number): void {
  // Ctrl+9 is always the last tab, like in browsers.
  const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (tab) activate(tab.id);
}

function move(id: number, index: number): void {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, t);
  changed();
}

function openPaths(paths: string[], cwd: string): void {
  let last: Tab | undefined;
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    let kind: TabKind;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) kind = 'folder';
      else if (abs.endsWith('.code-workspace')) kind = 'workspace';
      else continue;
    } catch {
      continue;
    }
    last = tabs.find((t) => t.kind === kind && t.path === abs) ?? createTab({ kind, path: abs });
  }
  if (last) activate(last.id);
}

async function newTabDialog(): Promise<void> {
  const cur = activeTab();
  const r = await dialog.showOpenDialog(win, {
    title: 'Open Folder in New Tab',
    buttonLabel: 'Open',
    defaultPath: cur?.path ? path.dirname(cur.path) : app.getPath('home'),
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
  });
  if (!r.canceled) openPaths(r.filePaths, '/');
  else activeTab()?.view.webContents.focus();
}

// ---------------------------------------------------------------- window

function layout(): void {
  const { width, height } = win.getContentBounds();
  const showPage = !htmlFullscreen && activeTab() !== undefined && serverStatus.kind === 'ready';
  bar.setBounds({ x: 0, y: 0, width, height: htmlFullscreen ? 0 : showPage ? BAR_HEIGHT : height });
  const top = htmlFullscreen ? 0 : BAR_HEIGHT;
  for (const t of tabs) t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  const a = activeTab();
  if (a) a.view.setVisible(serverStatus.kind === 'ready');
}

function pushState(): void {
  if (bar.webContents.isDestroyed()) return;
  bar.webContents.send('tabs:state', {
    tabs: tabs.map((t) => ({
      id: t.id,
      label: labelOf(t),
      tooltip: t.path ?? 'No folder',
      // VS Code's default window.title starts with "● " while the active editor has unsaved changes.
      dirty: t.pageTitle.startsWith('●'),
      loading: t.loading,
    })),
    activeId,
    status: serverStatus,
    logFile: LOG_FILE,
  });
}

let saveTimer: NodeJS.Timeout | null = null;
function changed(): void {
  pushState();
  if (quitting) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  state.tabs = tabs.map((t) => ({ kind: t.kind, path: t.path }));
  state.active = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  if (server && !state.port) state.port = server.port; // the home port; see pickPort
  if (!win.isDestroyed()) {
    const b = win.getNormalBounds();
    state.bounds = { ...b, maximized: win.isMaximized() };
  }
  try {
    saveState(state);
  } catch (err) {
    console.error('vscode-tabs: could not save state:', (err as Error).message);
  }
}

function openExternal(url: string): void {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(url);
  } catch {
    /* ignore */
  }
}

// Wrapper shortcuts. Everything not matched here goes to VS Code untouched.
function installKeys(wc: WebContents): void {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || input.meta) return;
    const shift = input.shift;
    if (input.alt) {
      if (shift && input.code === 'KeyI') {
        activeTab()?.view.webContents.toggleDevTools();
        e.preventDefault();
      }
      return;
    }
    if (input.code === 'KeyT' && !shift) newTabDialog();
    else if (input.code === 'Tab') cycle(shift ? -1 : 1);
    else if (input.code === 'KeyW' && shift) {
      const t = activeTab();
      if (t) tryClose(t);
    } else if (!shift && /^Digit[1-9]$/.test(input.code)) jump(Number(input.code.slice(5)));
    else return;
    e.preventDefault();
  });
}

function createWindow(): void {
  const b = state.bounds;
  win = new BaseWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 820,
    x: b?.x,
    y: b?.y,
    title: 'VS Code Tabs',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#222226' : '#ebebed',
    show: false,
  });
  if (b?.maximized) win.maximize();

  bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-tabbar.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  bar.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#222226' : '#ebebed');
  installKeys(bar.webContents);
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bar.webContents.on('will-navigate', (e) => e.preventDefault());
  win.contentView.addChildView(bar);
  bar.webContents.loadFile(path.join(__dirname, '..', 'static', 'tabbar.html'));
  bar.webContents.once('did-finish-load', () => win.show());

  win.on('resize', layout);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    quit();
  });
  layout();
}

async function quit(): Promise<void> {
  persist(); // snapshot first; closing tabs below must not shrink the saved list
  quitting = true;
  const snapshot = tabs.map((t) => ({ kind: t.kind, path: t.path }));
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  for (const t of [...tabs]) {
    if (!(await tryClose(t))) {
      // A tab vetoed; reopen the ones that already closed (they had nothing unsaved).
      quitting = false;
      snapshot.forEach((s, i) => {
        if (!tabs.some((x) => x.kind === s.kind && x.path === s.path)) createTab(s, { index: Math.min(i, tabs.length) });
      });
      const a = tabs[activeIndex] ?? tabs[0];
      if (a) activate(a.id);
      return;
    }
  }
  await server?.stop();
  win.destroy();
  app.exit(0);
}

// ---------------------------------------------------------------- startup

function allowedPermission(url: string, permission: string): boolean {
  const ok = ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'fileSystem'];
  if (!ok.includes(permission) || !url) return false;
  if (server?.isOwnUrl(url)) return true;
  // VS Code webviews (Markdown preview etc.) are served from *.vscode-cdn.net; let them copy.
  try {
    return permission === 'clipboard-sanitized-write' && new URL(url).hostname.endsWith('.vscode-cdn.net');
  } catch {
    return false;
  }
}

app.on('second-instance', (_e, _argv, _cwd, data) => {
  const d = data as { args?: string[]; cwd?: string } | undefined;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (d?.args?.length) openPaths(d.args, d.cwd ?? process.cwd());
  }
});

app.on('window-all-closed', () => {
  /* quit() handles shutdown */
});
process.on('exit', () => server?.stopSync());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    persist();
    server?.stopSync();
    app.exit(0);
  });
}

app.whenReady().then(async () => {
  // No application menu: its default accelerators (Ctrl+W, Ctrl+R, Ctrl+Shift+I, …) would steal keys from VS Code.
  Menu.setApplicationMenu(null);

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowedPermission(details.requestingUrl, permission)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowedPermission(origin, permission));

  ipcMain.on('tabs:ready', (e) => e.sender === bar.webContents && pushState());
  ipcMain.on('tabs:new', (e) => e.sender === bar.webContents && newTabDialog());
  ipcMain.on('tabs:activate', (e, id: number) => e.sender === bar.webContents && activate(id));
  ipcMain.on('tabs:close', (e, id: number) => {
    const t = tabs.find((x) => x.id === id);
    if (e.sender === bar.webContents && t) tryClose(t);
  });
  ipcMain.on('tabs:move', (e, id: number, index: number) => e.sender === bar.webContents && move(id, index));

  createWindow();

  // Restore saved tabs right away (they load once the server is up).
  const restoreActive = state.active;
  for (const s of state.tabs) createTab(s);
  const a = tabs[restoreActive] ?? tabs[0];
  if (a) activate(a.id);
  openPaths(cliArgs, process.cwd());

  const codeBin = findCodeCli();
  if (!codeBin) {
    serverStatus = {
      kind: 'error',
      message: 'Could not find the `code` command. Install VS Code (it provides `code serve-web`) or set VSCODE_TABS_CODE.',
    };
    layout();
    pushState();
    return;
  }
  server = new CodeServer(codeBin, LOG_FILE);
  server.on('status', (s: ServerStatus) => {
    serverStatus = s;
    if (s.kind === 'ready') {
      const t = activeTab();
      if (t) ensureLoaded(t);
      t?.view.webContents.focus();
    }
    layout();
    pushState();
  });
  try {
    await server.start(state.port);
  } catch (err) {
    serverStatus = { kind: 'error', message: (err as Error).message };
    layout();
    pushState();
    return;
  }
  persist();
});
