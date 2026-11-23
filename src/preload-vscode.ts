// Preload for each VS Code tab.
//
// VS Code's web build only claims Ctrl+W, Ctrl+N, Ctrl+T and friends when it
// believes it runs as an installed app (`display-mode: standalone`); in a
// normal browser tab those keys belong to the browser. Here nothing else wants
// them, so report standalone mode and VS Code uses its desktop keybindings.
{
  const { contextBridge } = require('electron') as typeof import('electron');
  contextBridge.executeInMainWorld({
    func: () => {
      const original = window.matchMedia.bind(window);
      const standalone = /\(\s*display-mode\s*:\s*(standalone|window-controls-overlay)\s*\)/;
      window.matchMedia = (query: string): MediaQueryList => {
        const mql = original(query);
        if (!standalone.test(query)) return mql;
        return new Proxy(mql, {
          get(target, prop) {
            if (prop === 'matches') return true;
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      };
    },
  });
}
