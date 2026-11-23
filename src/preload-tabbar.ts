// Preload for the tab bar: a tiny IPC surface, nothing else.
{
  const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
  contextBridge.exposeInMainWorld('tabsApi', {
    onState: (cb: (state: unknown) => void) => ipcRenderer.on('tabs:state', (_e, s) => cb(s)),
    ready: () => ipcRenderer.send('tabs:ready'),
    newTab: () => ipcRenderer.send('tabs:new'),
    activate: (id: number) => ipcRenderer.send('tabs:activate', id),
    close: (id: number) => ipcRenderer.send('tabs:close', id),
    move: (id: number, index: number) => ipcRenderer.send('tabs:move', id, index),
  });
}
