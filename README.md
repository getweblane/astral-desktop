# Astral desktop — release host

This repository holds **only the published installers** for the Astral Windows
desktop client. There is no source here.

- **Source**: the `desktop/` package of the private `getweblane/astral` monorepo.
- **Releases**: [Releases](https://github.com/getweblane/astral-desktop/releases) —
  each carries `Astral-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`.
- **Who reads them**: the installed app's auto-updater (electron-updater, GitHub
  provider) polls `latest.yml` from the latest release; the landing page's
  `/download` redirects to the newest `.exe` asset.
- **How a release is cut**: `node dev/release.mjs <version>` in the monorepo
  (see `docs/desktop-shipping.md` there). Nothing in this repo builds anything —
  do not add workflows that react to tags.

The original July 2026 prototype that lived on `main` is preserved on the
`archive/electron-vite-app` branch. Its releases (v0.1.x) used a different
`appId`, so they install side by side with 1.x rather than upgrading in place.
