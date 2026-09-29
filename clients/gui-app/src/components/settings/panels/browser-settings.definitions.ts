import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const BROWSER = defineSettingsSection("browser", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Browser",
    description:
      "Search, agent access, tab placement, and saved website sessions.",
    keywords: [
      "cookies",
      "logins",
      "stay signed in",
      "browser profile",
      "website sessions",
    ],
  },
  // Gated on DATA and on the HOST: the card renders once a terminal has printed
  // a local URL, or once the active host advertises `config.browser.get` —
  // neither of which a shell can promise, so it folds into the page.
  search: {
    kind: "group",
    search: { anchor: "browser-search" },
    label: "Search",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["address bar", "query"],
  },
  searchEngine: {
    kind: "row",
    group: "search",
    search: { anchor: "browser-search-engine" },
    label: "Default search engine",
    description:
      "Used when typing search terms instead of a website address in the address bar.",
    availableWhen: alwaysAvailable,
    keywords: ["Google", "DuckDuckGo", "Bing", "Kagi", "omnibox"],
  },
  browser: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Browser",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // The row's description names the active host, so the rendered sentence is a
  // `status` and this static copy is what search reads.
  agentBrowserAccess: {
    kind: "row",
    group: "browser",
    search: { contributesTo: "page" },
    label: "Let agents use the in-app browser",
    description:
      "Agents get Traycer's browser as a tool and are told to use it for web pages. Turn off to let them use their own browser tooling.",
    availableWhen: alwaysAvailable,
    keywords: ["agent", "browser", "playwright", "mcp"],
  },
  detectedDevOrigins: {
    kind: "row",
    group: "browser",
    search: { contributesTo: "page" },
    label: "Detected dev origins",
    description:
      "Terminal URLs with local hosts or explicit ports are kept for browser-origin classification.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Gated on the HOST RUNTIME: the group also needs a bound host runtime and a
  // first successful read of the browser bridge, so none of it is a target.
  websiteSessions: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Website sessions",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  saveWebsiteSessions: {
    kind: "row",
    group: "websiteSessions",
    search: { contributesTo: "page" },
    label: "Save website sessions on this computer",
    // Says whether saving is on or paused, so the sentence is the row's status.
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  savedWebsiteSessions: {
    kind: "row",
    group: "websiteSessions",
    search: { contributesTo: "page" },
    label: "Saved website sessions",
    description:
      "Shared with connected Traycer hosts. Removing a site may sign you out there.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  bringInExistingSessions: {
    kind: "row",
    group: "websiteSessions",
    search: { contributesTo: "page" },
    label: "Bring in existing sessions",
    description:
      "Choose a browser or cookie file, then review the sites before importing.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  browserPlacement: {
    kind: "group",
    search: { anchor: "browser-placement" },
    label: "Browser placement",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["canvas", "pip", "picture in picture", "split"],
  },
  tileBrowser: {
    kind: "row",
    group: "browserPlacement",
    search: { anchor: "browser-tile-placement" },
    label: "Open browser tabs",
    description:
      "Choose where browser tabs appear. Changing this sets a browser-specific placement.",
    availableWhen: alwaysAvailable,
    keywords: ["canvas", "pip", "picture in picture", "split", "pane"],
  },
  // Its own group, not a fifth per-type row: the answer is whether the tile
  // appears at all, not where it lands, and a standalone row under "Open new
  // tiles" read as an override with the wrong tint.
  agentTabs: {
    kind: "group",
    search: { anchor: "opening-agent-tabs" },
    label: "Agent-opened tabs",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["agent", "popup", "browser", "surface"],
  },
  agentOpenedTabs: {
    kind: "row",
    group: "agentTabs",
    search: { anchor: "opening-tiles-agent-opened" },
    label: "Agent-opened tabs",
    description:
      "Tabs an agent opens while driving a browser session. Tabs a page opens, including links you click in it, always land as browser tiles.",
    availableWhen: alwaysAvailable,
    keywords: ["agent", "popup", "automatic", "background", "browser"],
  },
});
