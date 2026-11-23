// Tab bar renderer (runs in the tab bar view, no Node access).
{
  interface TabInfo {
    id: number;
    label: string;
    tooltip: string;
    dirty: boolean;
    loading: boolean;
  }
  interface BarState {
    tabs: TabInfo[];
    activeId: number | null;
    status: { kind: 'starting' | 'downloading' | 'ready' | 'error'; message?: string };
    logFile: string;
  }
  interface TabsApi {
    onState(cb: (s: BarState) => void): void;
    ready(): void;
    newTab(): void;
    activate(id: number): void;
    close(id: number): void;
    move(id: number, index: number): void;
  }
  const api = (window as unknown as { tabsApi: TabsApi }).tabsApi;

  const strip = document.getElementById('tabs')!;
  const placeholder = document.getElementById('placeholder')!;
  let dragId: number | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render(s: BarState): void {
    strip.replaceChildren(
      ...s.tabs.map((t, index) => {
        const tab = el('div', 'tab');
        tab.classList.toggle('active', t.id === s.activeId);
        tab.classList.toggle('dirty', t.dirty);
        tab.classList.toggle('loading', t.loading);
        tab.title = t.tooltip;
        tab.draggable = true;
        tab.setAttribute('role', 'tab');
        tab.append(el('span', 'spinner'), el('span', 'label', t.label));
        const close = el('button', 'close');
        close.title = 'Close tab (Ctrl+Shift+W)';
        close.setAttribute('aria-label', 'Close tab');
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          api.close(t.id);
        });
        tab.append(close);
        tab.addEventListener('mousedown', (e) => {
          if (e.button === 0) api.activate(t.id);
        });
        tab.addEventListener('auxclick', (e) => {
          if (e.button === 1) api.close(t.id);
        });
        tab.addEventListener('dragstart', (e) => {
          dragId = t.id;
          e.dataTransfer!.effectAllowed = 'move';
        });
        tab.addEventListener('dragover', (e) => {
          if (dragId === null) return;
          e.preventDefault();
        });
        tab.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragId === null || dragId === t.id) return;
          const r = tab.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          const from = s.tabs.findIndex((x) => x.id === dragId);
          let to = index + (after ? 1 : 0);
          if (from < to) to--;
          api.move(dragId, to);
        });
        tab.addEventListener('dragend', () => (dragId = null));
        return tab;
      }),
    );

    let message = '';
    let detail = '';
    if (s.status.kind === 'starting') message = 'Starting VS Code server…';
    else if (s.status.kind === 'downloading') {
      message = 'Downloading VS Code server…';
      detail = 'code serve-web fetches the server matching your VS Code version on first run.';
    } else if (s.status.kind === 'error') {
      message = 'VS Code server is not running';
      detail = `${s.status.message ?? ''}\nLog: ${s.logFile}`;
    } else if (s.tabs.length === 0) {
      message = 'No folder open';
      detail = 'Press Ctrl+T or click + to open a folder in a new tab.';
    }
    document.body.classList.toggle('full', message !== '');
    placeholder.replaceChildren(el('div', 'message', message), el('div', 'detail', detail));
  }

  document.getElementById('new')!.addEventListener('click', () => api.newTab());
  strip.addEventListener('dblclick', (e) => {
    if (e.target === strip) api.newTab();
  });
  api.onState(render);
  api.ready();
}
