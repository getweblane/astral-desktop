import { app, BrowserWindow, dialog, session, shell } from "electron";
import { join } from "path";
import { autoUpdater } from "electron-updater";

// ---------------------------------------------------------------------------
// Target URL
// ---------------------------------------------------------------------------
// `astral.wbl.is` is the deployed NEXT_PUBLIC_APP_URL. In a packaged build we
// always point at prod; running unpackaged (`pnpm dev` / `pnpm start`) points
// at the local Next.js dev server. `ASTRAL_URL` overrides either for testing.
const PROD_URL = "https://astral.wbl.is";
const DEV_URL = "http://localhost:3000";

const isDev = !app.isPackaged && process.env.ASTRAL_PROD !== "1";
const BASE_URL = process.env.ASTRAL_URL ?? (isDev ? DEV_URL : PROD_URL);
const APP_ORIGIN = new URL(BASE_URL).origin;

// Boot onto `/login`, not the marketing landing page: that route signs the user
// in, or redirects straight into the app when the `wl_session` cookie is still
// valid. (Origin is unchanged, so in-window navigation rules below still hold.)
const APP_URL = new URL("/login", BASE_URL).toString();

// Persistent partition → Chromium stores the httpOnly `wl_session` cookie on
// disk, so login survives restarts for the cookie's 30-day rolling lifetime.
const PARTITION = "persist:astral";

// Windows: needed for notifications/taskbar to attribute to the right app.
const APP_USER_MODEL_ID = "com.astral.desktop";

// Single instance — also the foundation for `astral://` deep links later.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** Open a URL in the system browser, swallowing parse errors. */
function openExternal(url: string): void {
  try {
    void shell.openExternal(url);
  } catch {
    /* ignore malformed URLs */
  }
}

/** True if `url` belongs to the Astral app origin (keep it in-window). */
function isInternal(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const ses = session.fromPartition(PARTITION);

  // The dialer uses sip.js/WebRTC and needs the microphone; also allow native
  // notifications and sanitized clipboard writes. Everything else is denied.
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
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  void win.loadURL(APP_URL);

  // Keep app navigation in-window; send everything else (magic links, OAuth
  // provider pages, external dashboards) to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: "allow" };
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  return win;
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
