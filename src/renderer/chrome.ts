// Renderer for the window chrome: renders the tab strip + nav state from the
// `ChromeState` snapshots main pushes, and forwards clicks back as intents.
// All Electron access is via the `window.astralChrome` bridge (preload/chrome.ts).
export {}; // make this a module so `declare global` is legal

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

interface AstralChrome {
  platform: string;
  onState: (cb: (state: ChromeState) => void) => () => void;
  ready: () => void;
  newTab: () => void;
  selectTab: (id: number) => void;
  closeTab: (id: number) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

declare global {
  interface Window {
    astralChrome: AstralChrome;
  }
}

const api = window.astralChrome;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const tabsEl = $("tabs");
const backBtn = $<HTMLButtonElement>("back");
const forwardBtn = $<HTMLButtonElement>("forward");
const maxBtn = $("max");

if (api.platform === "darwin") document.documentElement.classList.add("mac");

// Static controls.
$("newtab").addEventListener("click", () => api.newTab());
backBtn.addEventListener("click", () => api.back());
forwardBtn.addEventListener("click", () => api.forward());
$("reload").addEventListener("click", () => api.reload());
$("min").addEventListener("click", () => api.minimize());
maxBtn.addEventListener("click", () => api.toggleMaximize());
$("close").addEventListener("click", () => api.close());

function makeTab(tab: TabSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = tab.active ? "tab active" : "tab";
  el.title = tab.title;
  el.addEventListener("click", () => api.selectTab(tab.id));
  // Middle-click closes, like a browser.
  el.addEventListener("auxclick", (e) => {
    if (e.button === 1) api.closeTab(tab.id);
  });

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = tab.title;

  const close = document.createElement("button");
  close.className = "close";
  close.setAttribute("aria-label", "Close tab");
  close.textContent = "✕";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.closeTab(tab.id);
  });

  el.append(title, close);
  return el;
}

api.onState((state) => {
  tabsEl.replaceChildren(...state.tabs.map(makeTab));
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  maxBtn.textContent = state.isMaximized ? "❐" : "▢"; // ❐ vs ▢
});

api.ready();
