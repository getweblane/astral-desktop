import { contextBridge } from "electron";

// Tiny, read-only bridge so the web app can detect it's running inside the
// desktop shell. The web login UI can check `window.astralDesktop?.isDesktop`
// to default to the 6-digit code entry (the magic link opens the system
// browser, not this window) and to gate desktop notifications.
const api = {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version ?? "",
} as const;

contextBridge.exposeInMainWorld("astralDesktop", api);
