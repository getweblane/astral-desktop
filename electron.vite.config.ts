import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Thin shell: we only build `main` and `preload`. There is no local renderer —
// the window loads the hosted Astral web app over the network — so no renderer
// config is declared here.
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
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
});
