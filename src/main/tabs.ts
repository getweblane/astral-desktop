import { BrowserWindow, WebContentsView, shell } from "electron";

// The state snapshot the main process pushes to the chrome renderer on every
// change (new/close/select tab, navigation, load start/stop, maximize). The
// renderer is a pure view of this — it holds no tab state of its own.
export interface TabSummary {
  id: number;
  title: string;
  active: boolean;
}

export interface ChromeState {
  tabs: TabSummary[];
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  isMaximized: boolean;
}

interface Tab {
  id: number;
  view: WebContentsView;
}

export interface TabManagerOptions {
  /** The frameless host window whose base webContents renders the chrome. */
  win: BrowserWindow;
  /** Shared session partition → every tab reuses the one login cookie. */
  partition: string;
  /** Preload injected into each tab (window.astralDesktop bridge). */
  preload: string;
  /** Height in DIPs of the chrome bar; tab views start below it. */
  chromeHeight: number;
  /** URL a fresh tab boots onto (Astral `/login`). */
  startUrl: string;
  /** Origin kept in-window; anything else opens in the system browser. */
  appOrigin: string;
}

/**
 * Owns the set of web-app tabs for one window. Each tab is a `WebContentsView`
 * stacked above the chrome; only the active one is attached to the layout, so
 * switching tabs is a detach/attach rather than a show/hide. The chrome renderer
 * never touches Electron directly — it sends commands and receives `ChromeState`.
 */
export class TabManager {
  private tabs: Tab[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private readonly win: BrowserWindow;
  private readonly opts: TabManagerOptions;

  constructor(opts: TabManagerOptions) {
    this.win = opts.win;
    this.opts = opts;
    this.win.on("resize", () => this.layoutActive());
    this.win.on("maximize", () => this.pushState());
    this.win.on("unmaximize", () => this.pushState());
    this.win.on("enter-full-screen", () => this.layoutActive());
    this.win.on("leave-full-screen", () => this.layoutActive());
  }

  /** Called once the chrome renderer has attached its listeners. */
  onChromeReady(): void {
    if (this.tabs.length === 0) this.newTab();
    else this.pushState();
  }

  newTab(url?: string): number {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.opts.partition,
        preload: this.opts.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });
    const id = this.nextId++;
    const wc = view.webContents;

    // Same gating as the old single window: internal `window.open` becomes a new
    // tab, everything else (magic links, OAuth pages) opens in the system browser.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (this.isInternal(target)) this.newTab(target);
      else this.openExternal(target);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, target) => {
      if (!this.isInternal(target)) {
        event.preventDefault();
        this.openExternal(target);
      }
    });

    const update = (): void => this.pushState();
    wc.on("page-title-updated", update);
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);

    this.tabs.push({ id, view });
    void wc.loadURL(url ?? this.opts.startUrl);
    this.select(id);
    return id;
  }

  select(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    if (this.activeId !== null && this.activeId !== id) {
      const prev = this.tabs.find((t) => t.id === this.activeId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }

    this.activeId = id;
    this.win.contentView.addChildView(tab.view);
    this.layoutActive();
    this.pushState();
    tab.view.webContents.focus();
  }

  close(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    const [tab] = this.tabs.splice(idx, 1);
    const wasActive = this.activeId === id;
    if (wasActive) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    // Closing the last tab closes the window, like a browser.
    if (this.tabs.length === 0) {
      if (!this.win.isDestroyed()) this.win.close();
      return;
    }
    if (wasActive) {
      const next = this.tabs[idx] ?? this.tabs[this.tabs.length - 1];
      this.select(next.id);
    } else {
      this.pushState();
    }
  }

  back(): void {
    const wc = this.activeWebContents();
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(): void {
    const wc = this.activeWebContents();
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(): void {
    this.activeWebContents()?.reload();
  }

  /** Close every tab's webContents; call when the host window goes away. */
  destroyAll(): void {
    for (const tab of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs = [];
    this.activeId = null;
  }

  private activeWebContents(): Electron.WebContents | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab ? tab.view.webContents : null;
  }

  private layoutActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const top = this.opts.chromeHeight;
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  private pushState(): void {
    if (this.win.isDestroyed()) return;
    const wc = this.activeWebContents();
    const state: ChromeState = {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: t.view.webContents.getTitle() || "astral",
        active: t.id === this.activeId,
      })),
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
      isMaximized: this.win.isMaximized(),
    };
    this.win.webContents.send("chrome:state", state);
  }

  private isInternal(url: string): boolean {
    try {
      return new URL(url).origin === this.opts.appOrigin;
    } catch {
      return false;
    }
  }

  private openExternal(url: string): void {
    try {
      void shell.openExternal(url);
    } catch {
      /* ignore malformed URLs */
    }
  }
}
