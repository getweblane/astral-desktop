# Astral Desktop — build plan

A thin Electron shell that loads the hosted Astral web app and adds native desktop
behavior (window, tray, notifications, auto-update). It does **not** bundle the
Next.js server or DB — Astral is a server-backed app (Prisma + Postgres, server
auth, SIP/WebRTC), so the desktop app points at the deployed URL.

> Context for a fresh session: the web app lives at `w:\development\astral`
> (Next.js 16, pnpm). This repo (`astral-desktop`) is the wrapper only. Read the
> "How Astral works" section before writing code — the auth and mic details drive
> the whole design.

---

## How Astral works (facts this plan depends on)

Verified from the `astral` repo on 2026-06-16:

- **App identity:** name "astral", workspace dialer / calls & customers. Theme
  color `#181818` (OLED black), `start_url` `/calls`, icons at `/icons/icon-512`.
  (`app/manifest.ts`)
- **Auth is passwordless** — magic link **+ 6-digit OTP code**. Flow: enter email
  → `/api/auth/send-link` emails a link and a code → user either clicks the link
  (`/api/auth/verify?token=`) or types the code (`/api/auth/verify-code`). Both
  call `createSession` + `setSessionCookie`. (`lib/auth.ts`, `lib/session.ts`)
- **Session cookie** `wl_session`: `httpOnly`, `secure` in prod, `sameSite: lax`,
  `path: /`, 30-day rolling expiry. (`lib/session.ts:179`)
- **There is a Bearer-token path** (OAuth access tokens via `validateAccessToken`)
  in `lib/session-request.ts`, but it's for the MCP/OAuth surface, not normal
  login. We use cookie auth — don't go down the Bearer road.
- **The dialer uses WebRTC + microphone** (`sip.js`). The window MUST grant mic
  permission or calling silently fails.
- **Prod URL** is the web app's `NEXT_PUBLIC_APP_URL`. Get the real value before
  shipping (placeholder below).

### Two auth consequences for Electron (the crux)

1. **Cookie persistence.** `wl_session` is `httpOnly`, so renderer JS can't touch
   it — but it's set on the response and Chromium stores it. Load the app in a
   **persistent session partition** (`persist:astral`) and the cookie survives
   restarts automatically. Use the persistent partition and login sticks for 30
   days; that's all that's required.

2. **The magic link opens the default browser, not the app.** If the user clicks
   the email link, the cookie gets set in their *browser*, not in Electron — they
   stay logged out in the app. **Solution: inside the desktop app, use the 6-digit
   code path.** It's on the same login screen and sets the cookie in whatever
   client POSTed it (the Electron window). No web-app change needed for MVP.
   *(Optional polish later: `astral://` deep links — see Phase 5.)*

---

## Decisions (already made)

- **Thin shell**, loads remote URL. No bundled server. ✅ (separate repo confirmed)
- **Tooling:** TypeScript + `electron-vite` (clean main/preload TS build) +
  `electron-builder` (packaging) + `electron-updater` (auto-update). pnpm, to
  match the web repo.
- **Primary target Windows** ("use it on my pc"); mac/linux targets defined but
  secondary.
- **Auth:** cookie session via persistent partition; steer users to the OTP code.

## Open questions (confirm before/while building)

- [ ] **Real production URL** (set `PROD_URL`). Until then dev points at
      `http://localhost:3000`.
- [ ] **Code signing** — Windows: ship unsigned for personal use (users get a
      one-time SmartScreen "more info → run anyway"); buy an EV/OV cert before
      wider distribution. macOS auto-update *requires* signing + notarization, so
      defer mac releases until you have an Apple Developer cert.
- [ ] **Auto-update host** — GitHub Releases is simplest (`electron-updater`
      `github` provider). Confirm the repo is public or provide a token.
- [ ] **App icons** — export `icon.ico` / `icon.icns` / `512.png` from the same
      source as the web `/icons` (the spark glyph on `#181818`).

---

## File layout

```
astral-desktop/
├─ PLAN.md                  ← this file
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json
├─ build/                   ← icons (icon.ico, icon.icns, icon.png) + entitlements
└─ src/
   ├─ main/index.ts         ← window, session partition, permissions, links, updater
   └─ preload/index.ts      ← tiny contextBridge: expose `window.astralDesktop`
```

---

## Phase 1 — Scaffold

1. `git init` (repo dir is currently empty).
2. Scaffold with electron-vite, then strip the sample renderer (we load a remote
   URL, so there is no local renderer to bundle — keep only `main` + `preload`):
   ```
   pnpm create @quick-start/electron astral-desktop --template vanilla-ts
   ```
   or hand-roll the files below. Either way, `main` and `preload` are the only
   build inputs.
3. Deps:
   ```
   pnpm add -D electron electron-vite electron-builder typescript @types/node
   pnpm add electron-updater
   ```
4. `package.json` scripts:
   ```jsonc
   {
     "main": "out/main/index.js",
     "scripts": {
       "dev": "ASTRAL_DEV=1 electron-vite dev",
       "build": "electron-vite build",
       "start": "electron-vite preview",
       "dist": "electron-vite build && electron-builder",
       "dist:win": "electron-vite build && electron-builder --win"
     }
   }
   ```

## Phase 2 — Main process (the important part)

`src/main/index.ts`:

```ts
import { app, BrowserWindow, session, shell } from "electron";
import { join } from "path";
import { autoUpdater } from "electron-updater";

const PROD_URL = "https://app.astral.example"; // TODO: real NEXT_PUBLIC_APP_URL
const DEV_URL = "http://localhost:3000";
const APP_URL = process.env.ASTRAL_DEV ? DEV_URL : PROD_URL;
const APP_ORIGIN = new URL(APP_URL).origin;
const PARTITION = "persist:astral"; // persistent → wl_session survives restarts

// single instance (also required for deep links on Windows)
if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const ses = session.fromPartition(PARTITION);

  // Dialer needs the mic (sip.js/WebRTC); also allow native notifications.
  const ALLOWED = new Set(["media", "notifications", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));

  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 380,            // app has a real mobile/narrow layout
    backgroundColor: "#181818", // theme color → no white flash on boot
    show: false,
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
  win.loadURL(APP_URL);

  // Keep app navigation in-window; send everything else to the system browser
  // (magic links, external dashboards, oauth provider pages, etc.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  if (!process.env.ASTRAL_DEV) autoUpdater.checkForUpdatesAndNotify();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

## Phase 3 — Preload (let the web app know it's in the desktop)

`src/preload/index.ts`:

```ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("astralDesktop", {
  isDesktop: true,
  platform: process.platform,
});
```

Optional (small web-app change, high value): in the login UI, if
`window.astralDesktop?.isDesktop`, default to the **code entry** instead of the
magic-link button — closes the "link opens in browser" gap. Also gate desktop
notifications on this flag.

## Phase 4 — Packaging + auto-update

`electron-builder.yml`:

```yaml
appId: com.astral.desktop
productName: Astral
directories: { output: dist, buildResources: build }
files: ["out/**"]
win:
  target: nsis
  icon: build/icon.ico
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true }
mac:
  target: dmg
  icon: build/icon.icns
  category: public.app-category.business
linux: { target: AppImage, icon: build/icon.png }
publish:
  provider: github
  owner: nissim          # TODO confirm
  repo: astral-desktop
```

- `pnpm dist:win` → NSIS installer in `dist/`.
- Auto-update: `electron-updater` reads the GitHub Releases feed. Tag a release,
  upload the installer + `latest.yml`, and installed clients update on next launch.
- Versioning is independent of the web app — bump `package.json` version per
  desktop release only.

## Phase 5 — Native polish (optional, after MVP works)

- **Tray + menu**: minimize-to-tray, quick "New call" → loads `/dialer`.
- **Badge/notifications**: forward in-app notifications to OS via the renderer
  `Notification` API (works in Electron; gated by the permission handler above).
- **Deep links for magic links** — make the email link work in-app:
  `app.setAsDefaultProtocolClient("astral")`, handle `open-url` (mac) +
  `second-instance` (win), and have the web `/api/auth/verify` route 302 to
  `astral://verify?token=…` when the request comes from the desktop. Lets users
  click the email link and land logged-in inside the app. Skip for MVP — the OTP
  code already covers it.
- **Window state**: persist size/position (e.g. `electron-window-state`).

---

## Definition of done (MVP)

- [ ] `pnpm dev` opens a window on `localhost:3000`, you log in with the 6-digit
      code, and the session persists across an app restart.
- [ ] The dialer can place a call (mic permission granted, audio works).
- [ ] External links open in the system browser; app nav stays in-window.
- [ ] `pnpm dist:win` produces an installer that runs on a clean Windows machine.
- [ ] `PROD_URL` set to the real deployment and a signed-or-not release is tagged.

## First-session smoke test

1. Start the web app in `w:\development\astral` (`pnpm dev`, port 3000).
2. In `astral-desktop`: `pnpm dev`.
3. Log in via **code** (not the magic link). Confirm you reach `/calls`.
4. Quit and relaunch the app → should still be logged in.
5. Open the dialer, place a test call → confirm mic works.
```
