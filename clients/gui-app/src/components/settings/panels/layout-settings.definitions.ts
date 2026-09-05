import {
  alwaysAvailable,
  isStatusBarControlsAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * Where the app's own chrome sits and how much of it shows.
 *
 * The page's rows come from three stores rather than one - `layout-store` for
 * the status bar, `settings-store` for the rows relocated here from General
 * and Appearance - so the collection is what says they are one page. Each
 * relocated row keeps the name it had there as a keyword, since that is the
 * word a reader who remembers the old home will type.
 *
 * The footer controls are gated on the BUILD: the installed mobile app draws
 * no status bar, so `isStatusBarControlsAvailable` withholds them and the
 * group collapses to a note plus the one row that was never about the footer.
 */
export const LAYOUT = defineSettingsSection("layout", {
  page: {
    label: "Layout",
    description: "Where the app's chrome sits and how much of it shows.",
    keywords: [
      "chrome",
      "footer",
      "header",
      "arrange",
      "position",
      "visibility",
    ],
  },
  statusBar: {
    kind: "group",
    search: { anchor: "layout-status-bar" },
    label: "Status bar",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["footer", "bottom bar", "strip", "usage", "rate limits"],
  },
  // The note that stands in for the group's contents on a build with no
  // footer. It has no entry of its own: a search result promising it would
  // land on nothing wherever the footer IS drawn.
  desktopOnlyNote: {
    kind: "row",
    group: "statusBar",
    search: { contributesTo: "statusBar" },
    label: "Status bar is desktop-only",
    description:
      "The mobile app keeps usage limits and the resource monitor in its header.",
    availableWhen: alwaysAvailable,
    keywords: ["mobile", "phone", "desktop"],
  },
  // Drawn only under `header` placement (and always in the mobile app, where
  // the header is the only surface left) - a MODE, so it folds into the group
  // rather than promising an anchor most installs would not resolve.
  headerResourceMonitor: {
    kind: "row",
    group: "statusBar",
    search: { contributesTo: "statusBar" },
    label: "Show resource monitor in header",
    description: "Show the app-wide resource monitor beside the usage gauge.",
    availableWhen: alwaysAvailable,
    keywords: [
      "cpu",
      "memory",
      "ram",
      "monitor",
      "toolbar",
      // The name this row had on General before it moved here.
      "show global resources button",
    ],
  },
  placement: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-placement" },
    label: "Placement",
    description: "Where usage limits and the resource monitor live.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["header", "footer", "bottom", "position", "move"],
  },
  percentMode: {
    kind: "row",
    group: "usageDisplay",
    search: { anchor: "layout-status-bar-percent-mode" },
    label: "Percentage",
    description: "Show how much is used, or how much remains.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["used", "remaining", "percent", "left"],
  },
  modeWord: {
    kind: "row",
    group: "usageDisplay",
    search: { anchor: "layout-status-bar-mode-word" },
    label: "Show used / remaining label",
    description:
      "Spell out the word after each percentage. Off leaves the number alone.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["word", "suffix", "used", "remaining", "percent"],
  },
  resetTimer: {
    kind: "row",
    group: "usageDisplay",
    search: { anchor: "layout-status-bar-reset-timer" },
    label: "Show reset timer",
    description:
      "Count down to each window's reset. Off shows the window's name (5h, wk).",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["countdown", "resets", "window name", "5h", "weekly"],
  },
  resourceScope: {
    kind: "row",
    group: "resourceMonitor",
    search: { anchor: "layout-status-bar-resource-scope" },
    label: "Scope",
    description:
      "Traycer's processes on the watched host, or this desktop app. RAM share is only available for the host scope.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["host", "desktop app", "processes", "measured"],
  },
  // The per-provider list is DATA: it exists only for providers the watched
  // host has reported. This row is the list's stand-in - the notice when the
  // host is unreachable, and the "nothing yet" line - so it carries their
  // vocabulary and the providers' own.
  providers: {
    kind: "row",
    group: "statusBar",
    search: { contributesTo: "usageLimits" },
    label: "Providers",
    description: "No provider on the watched host reports a usage window yet.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["provider", "codex", "claude", "watched host", "unreachable"],
  },
  composer: {
    kind: "group",
    search: { anchor: "layout-composer" },
    label: "Composer",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["prompt", "input", "message box", "toolbar", "chrome"],
  },
  composerFilesChanged: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-files-changed" },
    label: "Files changed",
    description:
      "Compact folds the row into a chip carrying its line counts; clicking the chip opens the full panel.",
    availableWhen: alwaysAvailable,
    keywords: ["diff", "changes", "line counts", "chip", "compact"],
  },
  composerActiveAgents: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-active-agents" },
    label: "Active agents",
    description:
      "Compact folds the row - and the responses received from other agents - into a chip counting what is running.",
    availableWhen: alwaysAvailable,
    keywords: ["running agents", "responses", "chip", "compact"],
  },
  composerBackground: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-background" },
    label: "Background",
    description:
      "Compact folds the row into a chip counting what is running in the background.",
    availableWhen: alwaysAvailable,
    keywords: ["background items", "shells", "chip", "compact"],
  },
  composerAttachImage: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-attach-image" },
    label: "Attach image",
    description:
      "Hidden removes the button. Pasting an image and dropping one on the composer still attach it.",
    availableWhen: alwaysAvailable,
    keywords: ["image", "attachment", "paste", "drop", "button", "hidden"],
  },
  composerAccess: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-access" },
    label: "Access",
    description:
      "Compact shows the permission mode as its icon alone, with the name on hover.",
    availableWhen: alwaysAvailable,
    keywords: ["permission mode", "permissions", "picker", "compact"],
  },
  composerMic: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-mic" },
    label: "Microphone",
    description:
      "Hidden removes the button. The dictation shortcut still starts voice input, and this does not turn voice input off.",
    availableWhen: alwaysAvailable,
    keywords: ["mic", "dictation", "voice input", "button", "hidden"],
  },
  composerCompactButton: {
    kind: "row",
    group: "composer",
    search: { anchor: "layout-composer-compact-button" },
    label: "Compact conversation",
    description:
      "Hidden removes the button beside the context reading. The command palette and /compact still compact a conversation.",
    availableWhen: alwaysAvailable,
    keywords: ["compact", "context", "summarize", "button", "hidden"],
  },
  usageLimits: {
    kind: "group",
    search: { anchor: "layout-status-bar-usage-limits" },
    label: "Usage limits",
    description: "One segment per provider with a window still reporting.",
    breadcrumb: "Status bar",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["rate limits", "quota", "providers", "segments"],
  },
  // A band inside the subgroup rather than a card of its own: the rows under
  // it are the ones a closed parent hides, so they reach search through it.
  usageDisplay: {
    kind: "group",
    search: { contributesTo: "usageLimits" },
    label: "Display",
    description:
      "What each reading spells out, before the strip runs out of room.",
    breadcrumb: "Usage limits",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["percentage", "label", "timer", "bar"],
  },
  miniBar: {
    kind: "row",
    group: "usageLimits",
    search: { anchor: "layout-status-bar-mini-bar" },
    label: "Show mini bar",
    description: "Draw a small fill bar ahead of each provider's windows.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["fill bar", "gauge", "meter", "progress"],
  },
  resourceMonitor: {
    kind: "group",
    search: { anchor: "layout-status-bar-resource-monitor" },
    label: "Resource monitor",
    description: "The watched host's CPU, memory and process numbers.",
    breadcrumb: "Status bar",
    availableWhen: isStatusBarControlsAvailable,
    keywords: [
      "cpu",
      "memory",
      "ram",
      "processes",
      "ram share",
      "metrics",
      "scope",
    ],
  },
  metrics: {
    kind: "row",
    group: "resourceMonitor",
    search: { anchor: "layout-status-bar-metrics" },
    label: "Metrics",
    description: "Which numbers the segment prints, in this order.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["cpu", "memory", "processes", "ram share", "chips"],
  },
  chat: {
    kind: "group",
    search: { anchor: "layout-chat" },
    label: "Chat",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["messages", "conversation", "pane"],
  },
  pinContextBreakdown: {
    kind: "row",
    group: "chat",
    search: { anchor: "layout-pin-context-breakdown" },
    label: "Pin context breakdown",
    description:
      "Keep the context window breakdown visible near the chat composer when usage data is available.",
    availableWhen: alwaysAvailable,
    keywords: [
      "context window",
      "tokens",
      "usage",
      // Its name on General before it moved here.
      "pin context usage breakdown",
    ],
  },
  minimapSide: {
    kind: "row",
    group: "chat",
    search: { anchor: "layout-minimap-side" },
    label: "Minimap position",
    description:
      "Minimaps are compact overviews for navigating chats and artifacts. Choose where they appear, or hide them.",
    availableWhen: alwaysAvailable,
    keywords: ["minimap", "overview", "left", "right", "hide", "minimap side"],
  },
  sidebar: {
    kind: "group",
    search: { anchor: "layout-sidebar" },
    label: "Sidebar",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["navigator", "rail", "left panel"],
  },
  // Both the panel list and the narrow-window note that stands in for it carry
  // this anchor, so the result lands on whichever the window draws. The gate is
  // the VIEWPORT, which no shell-level predicate can answer and which a resize
  // changes, so the entry is always offered. The per-panel rows inside it are
  // the rail's own registry rendered as rows; their names ride here.
  sidebarPanels: {
    kind: "group",
    search: { anchor: "layout-sidebar-panels" },
    label: "Panels",
    description:
      "Drag to reorder, or drop a panel onto another to stack them into one tabbed panel. Uncheck a panel to keep it out of the rail.",
    breadcrumb: "Sidebar",
    availableWhen: alwaysAvailable,
    keywords: [
      "reorder",
      "order",
      "drag",
      "tabbed",
      "stack",
      "hide panel",
      "visibility",
      "agents",
      "terminals",
      "browsers",
      "artifacts",
      "git diff",
      "pull requests",
      "file tree",
      "sharing",
      "comments",
    ],
  },
  // The note that stands in for the panel list below `md`. It contributes to
  // the group rather than owning an anchor, so a "Panels" result lands on the
  // card either way and never on a row only one width draws.
  sidebarPanelsNote: {
    kind: "row",
    group: "sidebar",
    search: { contributesTo: "sidebarPanels" },
    label: "Panel layout needs the sidebar",
    description:
      "The epic sidebar and its panel rail are only drawn on wider windows, so there is nothing to arrange here.",
    availableWhen: alwaysAvailable,
    keywords: ["narrow", "mobile", "width"],
  },
  sidebarResourceChips: {
    kind: "row",
    group: "sidebar",
    search: { anchor: "layout-sidebar-resource-chips" },
    label: "Show resource chips on sidebar rows",
    description:
      "Show compact live CPU and memory chips in task navigator rows.",
    availableWhen: alwaysAvailable,
    keywords: [
      "cpu",
      "memory",
      "ram",
      // Its name on General before it moved here.
      "show navigator resource stats",
    ],
  },
});
