import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// The window frame (tab strip + nav buttons + window controls) is a *local*
// renderer; the tab contents are the hosted Astral web app loaded over the
// network into WebContentsViews. So we now build all three targets: `main`,
// two `preload` bundles (one for the web-app tabs, one for the chrome), and
// the `renderer` chrome UI.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // `index` → injected into each web-app tab (window.astralDesktop).
          index: resolve(__dirname, "src/preload/index.ts"),
          // `chrome` → injected into the local chrome renderer (window.astralChrome).
          chrome: resolve(__dirname, "src/preload/chrome.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
