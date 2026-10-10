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
  // Where a search goes and where a tab lands: the two choices about the
  // person's own browsing. Each used to be a heading over one row.
  browsing: {
    kind: "group",
    search: { anchor: "browser-browsing" },
    label: "Browsing",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [
      "address bar",
      "query",
      "placement",
      "canvas",
      "pip",
      "picture in picture",
      "split",
    ],
  },
  searchEngine: {
    kind: "row",
    group: "browsing",
    search: { anchor: "browser-search-engine" },
    label: "Default search engine",
    description:
      "Used when typing search terms instead of a website address in the address bar.",
    availableWhen: alwaysAvailable,
    keywords: ["Google", "DuckDuckGo", "Bing", "Kagi", "omnibox"],
  },
  tileBrowser: {
    kind: "row",
    group: "browsing",
    search: { anchor: "browser-tile-placement" },
    label: "Open browser tabs",
    description:
      "Choose where browser tabs appear. Changing this sets a browser-specific placement.",
    availableWhen: alwaysAvailable,
    keywords: ["canvas", "pip", "picture in picture", "split", "pane"],
  },
  // What agents may do with the browser. Agent-opened tabs is drawn in every
  // shell, so the group is never empty; the two rows around it are gated on
  // the HOST and on DATA (below), which no shell can promise.
  agents: {
    kind: "group",
    search: { anchor: "browser-agents" },
    label: "Agents",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["agent", "popup", "browser", "surface"],
  },
  // Gated on the HOST: the row renders once the active host advertises
  // `config.browser.get` and `config.browser.set`, so it folds into the page.
  // Its description names the active host, so the rendered sentence is a
  // `status` and this static copy is what search reads.
  agentBrowserAccess: {
    kind: "row",
    group: "agents",
    search: { contributesTo: "page" },
    label: "Let agents use the in-app browser",
    description:
      "Agents get Traycer's browser as a tool and are told to use it for web pages. Turn off to let them use their own browser tooling.",
    availableWhen: alwaysAvailable,
    keywords: ["agent", "browser", "playwright", "mcp"],
  },
  // Gated on the HOST like agent access, beside it because both decide which
  // tools an agent is launched with.
  agentPages: {
    kind: "row",
    group: "agents",
    search: { contributesTo: "page" },
    label: "Let agents show pages in chat",
    description:
      "Agents can build a page - a chart, a table, a mockup - and show it in the reply. Applies to agents started after you change it.",
    availableWhen: alwaysAvailable,
    keywords: ["agent", "page", "chart", "visualization", "html"],
  },
  // Beside agent access, not beside "Open browser tabs": the answer is whether
  // the tile appears at all, not where it lands, and next to the placement row
  // it read as an override of it.
  agentOpenedTabs: {
    kind: "row",
    group: "agents",
    search: { anchor: "opening-tiles-agent-opened" },
    label: "Agent-opened tabs",
    description:
      "Tabs an agent opens while driving a browser session. Tabs a page opens, including links you click in it, always land as browser tiles.",
    availableWhen: alwaysAvailable,
    keywords: ["agent", "popup", "automatic", "background", "browser"],
  },
  // Gated on DATA: the row renders once a terminal has printed a local URL,
  // so it folds into the page.
  detectedDevOrigins: {
    kind: "row",
    group: "agents",
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
});
