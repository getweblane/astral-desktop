import { contextBridge, ipcRenderer } from "electron";

// Bridge for the local chrome renderer (the tab strip / nav bar / window
// controls). It is deliberately command-and-events only: the renderer sends
// intents and receives a full `ChromeState` snapshot to render — it never
// reaches into Electron or holds authoritative tab state.
//
// Exposed as `window.astralChrome` (not `chrome`, which Chromium already owns).
interface TabSummary {
  id: number;
  title: string;
  active: boolean;
}

interface ChromeState {
  tabs: TabSummary[];
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  isMaximized: boolean;
}

const api = {
  platform: process.platform,

  /** Subscribe to state pushes; returns an unsubscribe fn. */
  onState(cb: (state: ChromeState) => void): () => void {
    const listener = (_e: unknown, state: ChromeState): void => cb(state);
    ipcRenderer.on("chrome:state", listener);
    return () => ipcRenderer.removeListener("chrome:state", listener);
  },

  /** Tell main the chrome is mounted and listening (triggers first state). */
  ready: (): void => ipcRenderer.send("chrome:ready"),

  newTab: (): void => ipcRenderer.send("tab:new"),
  selectTab: (id: number): void => ipcRenderer.send("tab:select", id),
  closeTab: (id: number): void => ipcRenderer.send("tab:close", id),

  back: (): void => ipcRenderer.send("nav:back"),
  forward: (): void => ipcRenderer.send("nav:forward"),
  reload: (): void => ipcRenderer.send("nav:reload"),

  minimize: (): void => ipcRenderer.send("win:minimize"),
  toggleMaximize: (): void => ipcRenderer.send("win:maximize"),
  close: (): void => ipcRenderer.send("win:close"),
} as const;

contextBridge.exposeInMainWorld("astralChrome", api);
