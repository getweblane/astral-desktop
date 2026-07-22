import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { join } from "path";
import { autoUpdater } from "electron-updater";
import { TabManager } from "./tabs";

// ---------------------------------------------------------------------------
// Target URL
// ---------------------------------------------------------------------------
// `astral.ing` is the deployed NEXT_PUBLIC_APP_URL. In a packaged build we
// always point at prod; running unpackaged (`pnpm dev` / `pnpm start`) points
// at the local Next.js dev server. `ASTRAL_URL` overrides either for testing.
const PROD_URL = "https://astral.ing";
const DEV_URL = "http://localhost:3000";

const isDev = !app.isPackaged && process.env.ASTRAL_PROD !== "1";
const BASE_URL = process.env.ASTRAL_URL ?? (isDev ? DEV_URL : PROD_URL);
const APP_ORIGIN = new URL(BASE_URL).origin;

// Boot onto `/login`, not the marketing landing page: that route signs the user
// in, or redirects straight into the app when the `wl_session` cookie is still
// valid. (Origin is unchanged, so in-window navigation rules still hold.)
const APP_URL = new URL("/login", BASE_URL).toString();

// Persistent partition → Chromium stores the httpOnly `wl_session` cookie on
// disk, so login survives restarts for the cookie's 30-day rolling lifetime.
// Every tab shares this partition, so a login in one tab logs in all of them.
const PARTITION = "persist:astral";

// Windows: needed for notifications/taskbar to attribute to the right app.
const APP_USER_MODEL_ID = "com.astral.desktop";

// Height (DIPs) of the custom chrome: 40px tab strip + 40px nav toolbar. Must
// stay in sync with the total height of #titlebar + #toolbar in chrome.css —
// the tab WebContentsViews are positioned exactly below it.
const CHROME_HEIGHT = 80;

// The chrome renderer's dev URL (electron-vite HMR server); unset in prod.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

const isMac = process.platform === "darwin";

// Maps a chrome host webContents id → its TabManager, so global IPC handlers
// can route a command to the window it came from (macOS can have several).
const managers = new Map<number, TabManager>();

// Single instance — also the foundation for `astral://` deep links later.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function managerFor(event: Electron.IpcMainEvent): TabManager | undefined {
  return managers.get(event.sender.id);
}

function windowFor(event: Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function createWindow(): BrowserWindow {
  const ses = session.fromPartition(PARTITION);

  // The dialer uses sip.js/WebRTC and needs the microphone; also allow native
  // notifications and sanitized clipboard writes. Everything else is denied.
  // Set on the shared partition, so it covers every tab's webContents.
  const ALLOWED = new Set([
    "media",
    "notifications",
    "clipboard-sanitized-write",
  ]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 380, // the app has a real narrow/mobile layout
    minHeight: 600,
    backgroundColor: "#181818", // theme color → no white flash on boot
    show: false,
    // Frameless everywhere so the tab strip reaches the top edge. On macOS we
    // keep the native traffic lights (hidden titlebar); on Windows/Linux the
    // chrome renderer draws its own min/max/close buttons.
    frame: false,
    titleBarStyle: isMac ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 12, y: 24 } : undefined,
    webPreferences: {
      // The host window renders the *local* chrome, so it gets the chrome
      // preload and the default session (not the astral partition).
      preload: join(__dirname, "../preload/chrome.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Load the local chrome UI (tab strip + nav + window controls).
  if (RENDERER_URL) void win.loadURL(RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));

  const tabs = new TabManager({
    win,
    partition: PARTITION,
    preload: join(__dirname, "../preload/index.js"),
    chromeHeight: CHROME_HEIGHT,
    startUrl: APP_URL,
    appOrigin: APP_ORIGIN,
  });
  // Capture the id now: on "closed" the webContents is already destroyed, so
  // `win.webContents.id` would throw.
  const chromeId = win.webContents.id;
  managers.set(chromeId, tabs);

  win.on("closed", () => {
    managers.delete(chromeId);
    tabs.destroyAll();
  });

  return win;
}

// ---------------------------------------------------------------------------
// IPC — chrome renderer → main
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.on("chrome:ready", (e) => managerFor(e)?.onChromeReady());
  ipcMain.on("tab:new", (e) => managerFor(e)?.newTab());
  ipcMain.on("tab:select", (e, id: unknown) => {
    if (typeof id === "number") managerFor(e)?.select(id);
  });
  ipcMain.on("tab:close", (e, id: unknown) => {
    if (typeof id === "number") managerFor(e)?.close(id);
  });
  ipcMain.on("nav:back", (e) => managerFor(e)?.back());
  ipcMain.on("nav:forward", (e) => managerFor(e)?.forward());
  ipcMain.on("nav:reload", (e) => managerFor(e)?.reload());

  ipcMain.on("win:minimize", (e) => windowFor(e)?.minimize());
  ipcMain.on("win:maximize", (e) => {
    const win = windowFor(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", (e) => windowFor(e)?.close());
}

// ---------------------------------------------------------------------------
// Updates — opt-in, never forced
// ---------------------------------------------------------------------------
// We poll the GitHub Releases feed but download *nothing* until the user says
// so, and we never restart out from under them. Two consent points: "download
// it?" when a release appears, and "restart now?" once it's on disk. If they
// decline the restart, the update applies the next time they quit on their own.
const SIX_HOURS = 6 * 60 * 60 * 1000;

function setupAutoUpdates(win: BrowserWindow): void {
  autoUpdater.autoDownload = false; // ask first — don't pull bytes silently
  autoUpdater.autoInstallOnAppQuit = true; // once downloaded, apply on next quit

  // One prompt per session: periodic re-checks shouldn't stack dialogs, and a
  // user who said "not now" isn't re-nagged until they relaunch.
  let prompted = false;

  autoUpdater.on("update-available", async (info) => {
    if (prompted) return;
    prompted = true;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Update", "Not now"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `A new version of astral (${info.version}) is available.`,
      detail: "Download it now? You can keep working — we'll let you know when it's ready to install.",
    });
    if (response === 0) void autoUpdater.downloadUpdate();
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `astral ${info.version} is ready to install.`,
      detail: "Restart now to apply it, or it'll be applied the next time you quit.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Network hiccup, no releases yet, etc. — non-fatal; stay on the current build.
  autoUpdater.on("error", (err) => console.error("[auto-update]", err));

  void autoUpdater.checkForUpdates();
  // Re-check periodically so a long-lived window still notices new releases.
  setInterval(() => void autoUpdater.checkForUpdates(), SIX_HOURS);
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  registerIpc();
  const win = createWindow();

  if (!isDev) setupAutoUpdates(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Focus the existing window if a second instance is launched.
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
