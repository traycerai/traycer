import { modLabel } from "@/lib/keybindings/platform";
import {
  alwaysAvailable,
  isExperimentalGroupAvailable,
  isPreventSleepRowAvailable,
  isVoiceInputRowAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * The composer's steering chord, and the only General copy that is
 * platform-derived. The row's label and description are built from it here, so
 * the result a search shows and the row it lands on print the same chord; the
 * panel imports it too, for the switch's accessible name.
 */
export const MOD_ENTER_LABEL = `${modLabel()}+Enter`;

export const GENERAL = defineSettingsSection("general", {
  page: {
    label: "General",
    description: "App behavior, agent activity, and local data controls.",
    keywords: [
      "preferences",
      "options",
      "misc",
      "website sessions",
      "save website sessions",
      "bring in existing sessions",
      "saved website sessions",
      "cookies",
      "logins",
      "stay signed in",
      "browser profile",
    ],
  },
  chatComposer: {
    kind: "group",
    search: { anchor: "general-chat-composer" },
    label: "Chat & composer",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["prompt", "input", "message box", "editor"],
  },
  voiceInput: {
    kind: "row",
    group: "chatComposer",
    search: { anchor: "general-voice-input" },
    label: "Voice input",
    description:
      "Dictate prompts with the mic button in the composer. Speech is transcribed on-device - audio never leaves your machine.",
    availableWhen: isVoiceInputRowAvailable,
    keywords: ["dictation", "dictate", "speech", "microphone", "mic", "audio"],
  },
  quoteReply: {
    kind: "row",
    group: "chatComposer",
    search: { anchor: "general-quote-reply" },
    label: "Quote reply on text selection",
    description:
      "Selecting assistant text shows a quote button that inserts the selection into the composer.",
    availableWhen: alwaysAvailable,
    keywords: ["quote", "select", "highlight", "cite", "reply"],
  },
  steerOnModEnter: {
    kind: "row",
    group: "chatComposer",
    search: { anchor: "general-steer-on-mod-enter" },
    label: `Steer with ${MOD_ENTER_LABEL}`,
    description: `While a turn is running on a supported harness, ${MOD_ENTER_LABEL} sends the composer text as a same-turn steering message that jumps the queue. Plain Enter keeps queueing.`,
    availableWhen: alwaysAvailable,
    keywords: [
      "steer",
      "steering",
      "interrupt",
      "queue",
      "same turn",
      "cmd",
      "ctrl",
      "shortcut",
    ],
  },
  // Gated on DATA: the card renders only once a terminal has printed a local
  // URL, which no shell can promise — so it folds into the page.
  browser: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Browser",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
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
  // Drawn by `PreventSleepSettingsSection` around its one row - the two
  // resource-visibility toggles that used to sit beside it moved to Layout -
  // so the group is gated exactly as that row is, and one gate hides the
  // heading with the row it headed.
  runningAgents: {
    kind: "group",
    search: { anchor: "general-running-agents" },
    label: "Running agents",
    description: null,
    breadcrumb: null,
    availableWhen: isPreventSleepRowAvailable,
    keywords: ["activity", "background", "power"],
  },
  preventSleep: {
    kind: "row",
    group: "runningAgents",
    search: { anchor: "general-prevent-sleep" },
    label: "Prevent sleep while running",
    description:
      "Keep the computer awake while an agent is running, so work continues when you step away.",
    availableWhen: isPreventSleepRowAvailable,
    keywords: [
      "sleep",
      "idle",
      "keep awake",
      "caffeinate",
      "power",
      "screensaver",
      "suspend",
    ],
  },
  // Layout lives here only until the app grows a page of its own for it; the
  // row moves there wholesale, store key, entry and all.
  layout: {
    kind: "group",
    search: { anchor: "general-layout" },
    label: "Layout",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["tabs", "tab strip", "chrome"],
  },
  homeTab: {
    kind: "row",
    group: "layout",
    search: { anchor: "general-home-tab" },
    label: "Home tab",
    description:
      "Show a fixed Home tab with everything running across your tasks.",
    availableWhen: alwaysAvailable,
    keywords: ["home", "tab strip", "overview", "focus view", "running"],
  },
  worktrees: {
    kind: "group",
    search: { anchor: "general-worktrees" },
    label: "Worktrees",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["git", "branch", "checkout"],
  },
  // Hand-built, not a `SettingsRow`: its sentence embeds a live preview of the
  // next branch name, so there is no fixed text to copy and the keywords carry
  // the vocabulary.
  branchPrefix: {
    kind: "row",
    group: "worktrees",
    search: { anchor: "general-branch-prefix" },
    label: "Default branch prefix",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: ["branch", "naming", "prefix", "git", "worktree"],
  },
  experimental: {
    kind: "group",
    search: { anchor: "general-experimental" },
    label: "Experimental",
    description: null,
    breadcrumb: null,
    availableWhen: isExperimentalGroupAvailable,
    keywords: ["beta", "preview", "feature flag", "labs"],
  },
  agentRoles: {
    kind: "row",
    group: "experimental",
    search: { anchor: "general-agent-roles" },
    label: "Agent roles",
    description:
      "Let agents claim durable responsibilities and coordinate through role-aware tools and prompts.",
    availableWhen: alwaysAvailable,
    keywords: ["roles", "coordination", "delegation", "feature flag"],
  },
  onboarding: {
    kind: "group",
    search: { anchor: "general-onboarding" },
    label: "Onboarding",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["tour", "welcome", "first run", "intro"],
  },
  productTour: {
    kind: "row",
    group: "onboarding",
    search: { anchor: "general-product-tour" },
    label: "Product tour",
    description: "Replay the first-launch onboarding tour.",
    availableWhen: alwaysAvailable,
    keywords: ["tour", "walkthrough", "replay", "welcome", "guide"],
  },
  dangerZone: {
    kind: "group",
    search: { anchor: "general-danger-zone" },
    label: "Danger Zone",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["reset", "destructive", "wipe"],
  },
  localAppState: {
    kind: "row",
    group: "dangerZone",
    search: { anchor: "general-local-app-state" },
    label: "Local app state",
    description:
      "Reset this device's app state - open tabs, layout, drafts, settings, and view preferences - then reload. You stay signed in. File edit snapshots are cleared from the host's own Overview page.",
    availableWhen: alwaysAvailable,
    keywords: ["clear", "reset", "cache", "storage", "wipe", "tabs", "layout"],
  },
});
