// Open tabs, saved to $XDG_STATE_HOME/vscode-tabs/tabs.json (default ~/.local/state).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type TabKind = 'folder' | 'workspace' | 'empty';

export interface SavedTab {
  kind: TabKind;
  path: string | null;
}

export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface State {
  version: 1;
  tabs: SavedTab[];
  active: number;
  port?: number;
  bounds?: Bounds;
}

export const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'vscode-tabs');
const stateFile = path.join(stateDir, 'tabs.json');

export function loadState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && s.version === 1 && Array.isArray(s.tabs)) {
      s.tabs = s.tabs.filter(
        (t: any) => t && ['folder', 'workspace', 'empty'].includes(t.kind) && (t.path === null || typeof t.path === 'string'),
      );
      return s as State;
    }
  } catch {
    /* missing or unreadable: start fresh */
  }
  return { version: 1, tabs: [], active: 0 };
}

export function saveState(s: State): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}
