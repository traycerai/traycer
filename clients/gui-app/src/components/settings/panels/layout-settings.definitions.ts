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
  rateLimitsEnabled: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-rate-limits" },
    label: "Show rate limits",
    description: "Show one segment per provider with a window still reporting.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["usage", "quota", "limits", "providers", "segments"],
  },
  percentMode: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-percent-mode" },
    label: "Percentage",
    description: "Show how much is used, or how much remains.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["used", "remaining", "percent", "left"],
  },
  resetTimer: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-reset-timer" },
    label: "Show reset timer",
    description:
      "Count down to each window's reset. Off shows the window's name (5h, wk).",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["countdown", "resets", "window name", "5h", "weekly"],
  },
  usageBar: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-usage-bar" },
    label: "Show usage bar",
    description: "Draw a small fill bar ahead of each provider's windows.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["fill bar", "gauge", "meter", "progress"],
  },
  // The provider rows below it exist only for providers the watched host has
  // reported - DATA, which no shell-level predicate can promise - so their
  // vocabulary rides here.
  resourcesEnabled: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-resources" },
    label: "Show resource monitor",
    description: "Show the watched host's CPU, memory and process numbers.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["cpu", "memory", "ram", "processes", "ram share", "metrics"],
  },
  resourceScope: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-resource-scope" },
    label: "Scope",
    description:
      "Traycer's processes on the watched host, or this desktop app. RAM share is only available for the host scope.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["host", "desktop app", "processes", "measured"],
  },
  // One row per metric, each drawn from a table in the panel. They are their
  // own rows, so each owns an entry rather than folding into the switch above.
  metricCpu: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-metric-cpu" },
    label: "CPU",
    description: "Processor share across the measured processes.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["processor", "load"],
  },
  metricMemory: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-metric-memory" },
    label: "Memory",
    description: "Resident memory across the measured processes.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["ram", "resident"],
  },
  metricProcesses: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-metric-processes" },
    label: "Processes",
    description: "How many processes are being measured.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["count", "measured"],
  },
  metricRamShare: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-status-bar-metric-ram-share" },
    label: "RAM share of host",
    description: "Measured memory as a share of the host machine's total.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["ram", "share", "total", "machine"],
  },
  // The per-provider list is DATA: it exists only for providers the watched
  // host has reported. This row is the list's stand-in - the notice when the
  // host is unreachable, and the "nothing yet" line - so it carries their
  // vocabulary and the providers' own.
  providers: {
    kind: "row",
    group: "statusBar",
    search: { contributesTo: "rateLimitsEnabled" },
    label: "Providers",
    description: "No provider on the watched host reports a usage window yet.",
    availableWhen: isStatusBarControlsAvailable,
    keywords: ["provider", "codex", "claude", "watched host", "unreachable"],
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
