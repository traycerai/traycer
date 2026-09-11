/**
 * Docs: see `src/components/settings/SETTINGS.md`.
 * Update that file whenever this index changes.
 */
import { modLabel } from "@/lib/keybindings/platform";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  alwaysAvailable,
  isExperimentalGroupAvailable,
  isPreventSleepRowAvailable,
  isPushPermissionGroupAvailable,
  isSystemNotificationsGroupAvailable,
  isVoiceInputRowAvailable,
  isZoomRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";

/**
 * The label of the composer's steering row, and the only entry here whose text
 * is platform-derived. It lives in the INDEX rather than in the panel because
 * the two must print the same string — a search result reading "Cmd+Enter"
 * that lands on a row reading "Ctrl+Enter" is a worse miss than no result at
 * all — and a data module is the half of that pair a panel may import.
 */
export const MOD_ENTER_LABEL = `${modLabel()}+Enter`;

/**
 * What a search hit IS, which is also what clicking it can promise.
 *
 * - `section` — a whole settings page. Lands at the top of it.
 * - `group` — a titled card inside a page ("Typography", "Running agents"),
 *   or a named region of a bespoke page that has no card.
 * - `setting` — one row, the thing a user actually came to change.
 *
 * The kind is not decoration: it breaks ties between equal-scoring hits (a row
 * beats the page containing it, because the row is the more specific answer to
 * the same words) and it is what the result list badges.
 */
export type SettingsSearchEntryKind = "section" | "group" | "setting";

export interface SettingsSearchEntry {
  /** The page this lives on — where a click navigates. */
  readonly section: SettingsSectionId;
  /**
   * The `data-settings-anchor` token on the element to scroll to and flash, or
   * `null` to land at the top of the page.
   *
   * Unique across the WHOLE index (asserted by the index test), so a lookup
   * never needs the section to disambiguate it, and a section component shared
   * by two panels can carry anchors that stay distinct if it is ever mounted
   * twice.
   *
   * `null` is a real answer, not a gap: a page whose content only exists once
   * a host answers an RPC has nothing stable to point at on a cold open, and a
   * link to an element that is not there yet is worse than a link to the page.
   */
  readonly anchor: string | null;
  readonly kind: SettingsSearchEntryKind;
  /**
   * Whether this entry's element exists in the given shell — the SAME
   * predicate the panel calls to decide whether to render it, so the index and
   * the surface cannot disagree (see `lib/settings/settings-availability.ts`).
   * An entry whose element is gated on anything else — data ("Detected dev
   * origins" renders only once a terminal printed a local URL), selected-host
   * identity, or a capability negotiated over host RPC — is not indexed at
   * all; its enclosing group or page is, with its vocabulary in the keywords.
   */
  readonly availableWhen: (context: SettingsAvailabilityContext) => boolean;
  /** Must match the text the surface actually renders. */
  readonly label: string;
  /** The row's own description where it has one — searched at low weight. */
  readonly description: string | null;
  /** The group this sits under, for the result's breadcrumb. */
  readonly group: string | null;
  /**
   * The words a user reaches for that the label does NOT contain. This is
   * where the search earns its keep: "dark mode" has to reach Theme, "proxy"
   * has to reach the Shell page, "stay signed in" has to reach the page that
   * holds website sessions. Synonyms, the old name of a renamed thing, and the
   * neighbouring vocabulary of the domain all belong here. Repeating a word
   * already in the label does not — the label is searched at a higher weight
   * than this is.
   */
  readonly keywords: ReadonlyArray<string>;
}

/**
 * Every settings surface a query can land on.
 *
 * Hand-written, and deliberately so. There is no schema behind this app's
 * settings — a "setting" is a hand-authored row in one of sixteen panels, and
 * the largest panels are bespoke JSX (Providers' per-provider tab bar, the
 * Worktrees inventory, the Host overview) with no row primitive to walk.
 * Nothing here can be derived from types. The price of hand-writing it is
 * drift, which is why every anchor is source-scanned by
 * `__tests__/settings-search-index.test.ts` rather than trusted.
 *
 * Coverage is honest about that split. Pages built on `SettingsRow` /
 * `SettingsGroup` are indexed down to the row; bespoke pages are indexed at
 * the page and region level with a keyword set rich enough to reach them.
 * A hit that lands one scroll from the control is a good outcome; a hit that
 * lands nowhere is not, so no entry promises an anchor a panel may not render.
 *
 * Labels and descriptions are COPIED from the surface, not paraphrased. A
 * result whose words differ from the row it lands on reads as the wrong
 * result, so a label change in a panel is a change here too.
 */
export const SETTINGS_SEARCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> = [
  // ---------------------------------------------------------------- General
  {
    section: "general",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "General",
    description: "App behavior, agent activity, and local data controls.",
    group: null,
    // Website sessions' group and rows are not indexed on their own: the group
    // also needs a bound host runtime and a successful first read of the
    // browser bridge, which no shell-level context can promise. Their words
    // land on this page instead.
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
  {
    section: "general",
    anchor: "general-chat-composer",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Chat & composer",
    description: null,
    group: null,
    keywords: ["prompt", "input", "message box", "editor"],
  },
  {
    section: "general",
    anchor: "general-voice-input",
    kind: "setting",
    availableWhen: isVoiceInputRowAvailable,
    label: "Voice input",
    description:
      "Dictate prompts with the mic button in the composer. Speech is transcribed on-device - audio never leaves your machine.",
    group: "Chat & composer",
    keywords: ["dictation", "dictate", "speech", "microphone", "mic", "audio"],
  },
  {
    section: "general",
    anchor: "general-quote-reply",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Quote reply on text selection",
    description:
      "Selecting assistant text shows a quote button that inserts the selection into the composer.",
    group: "Chat & composer",
    keywords: ["quote", "select", "highlight", "cite", "reply"],
  },
  {
    section: "general",
    anchor: "general-steer-on-mod-enter",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: `Steer with ${MOD_ENTER_LABEL}`,
    description: `While a turn is running on a supported harness, ${MOD_ENTER_LABEL} sends the composer text as a same-turn steering message that jumps the queue. Plain Enter keeps queueing.`,
    group: "Chat & composer",
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
  {
    section: "general",
    anchor: "general-pin-context-usage",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Pin context usage breakdown",
    description:
      "Keep the context window breakdown visible near the chat composer when usage data is available.",
    group: "Chat & composer",
    keywords: ["context window", "tokens", "breakdown"],
  },
  {
    section: "general",
    anchor: "general-running-agents",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Running agents",
    description: null,
    group: null,
    keywords: ["activity", "background", "resources"],
  },
  {
    section: "general",
    anchor: "general-prevent-sleep",
    kind: "setting",
    availableWhen: isPreventSleepRowAvailable,
    label: "Prevent sleep while running",
    description:
      "Keep the computer awake while an agent is running, so work continues when you step away.",
    group: "Running agents",
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
  {
    section: "general",
    anchor: "general-global-resources-button",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Show global resources button",
    description: "Show the app-wide resource monitor in the header.",
    group: "Running agents",
    keywords: ["cpu", "memory", "ram", "monitor", "header", "toolbar"],
  },
  {
    section: "general",
    anchor: "general-navigator-resource-stats",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Show navigator resource stats",
    description:
      "Show compact live CPU and memory chips in task navigator rows.",
    group: "Running agents",
    keywords: ["cpu", "memory", "ram", "chips", "sidebar"],
  },
  {
    section: "general",
    anchor: "general-worktrees",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Worktrees",
    description: null,
    group: null,
    keywords: ["git", "branch", "checkout"],
  },
  {
    section: "general",
    anchor: "general-branch-prefix",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Default branch prefix",
    // The row's sentence embeds a live preview of the next branch name, so
    // there is no fixed text to copy; the keywords carry the vocabulary.
    description: null,
    group: "Worktrees",
    keywords: ["branch", "naming", "prefix", "git", "worktree"],
  },
  {
    section: "general",
    anchor: "general-experimental",
    kind: "group",
    availableWhen: isExperimentalGroupAvailable,
    label: "Experimental",
    description: null,
    group: null,
    keywords: ["beta", "preview", "feature flag", "labs"],
  },
  {
    section: "general",
    anchor: "general-agent-roles",
    kind: "setting",
    availableWhen: isExperimentalGroupAvailable,
    label: "Agent roles",
    description:
      "Let agents claim durable responsibilities and coordinate through role-aware tools and prompts.",
    group: "Experimental",
    keywords: ["roles", "coordination", "delegation", "feature flag"],
  },
  {
    section: "general",
    anchor: "general-onboarding",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Onboarding",
    description: null,
    group: null,
    keywords: ["tour", "welcome", "first run", "intro"],
  },
  {
    section: "general",
    anchor: "general-product-tour",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Product tour",
    description: "Replay the first-launch onboarding tour.",
    group: "Onboarding",
    keywords: ["tour", "walkthrough", "replay", "welcome", "guide"],
  },
  {
    section: "general",
    anchor: "general-danger-zone",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Danger Zone",
    description: null,
    group: null,
    keywords: ["reset", "destructive", "wipe"],
  },
  {
    section: "general",
    anchor: "general-local-app-state",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Local app state",
    description:
      "Reset this device's app state - open tabs, layout, drafts, settings, and view preferences - then reload. You stay signed in. File edit snapshots are cleared from the host's own Overview page.",
    group: "Danger Zone",
    keywords: ["clear", "reset", "cache", "storage", "wipe", "tabs", "layout"],
  },

  // ------------------------------------------------------------- Appearance
  {
    section: "appearance",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Appearance",
    description: "Theme, typography, and focused visual customization.",
    group: null,
    keywords: [
      "look",
      "style",
      "visual",
      "ui",
      // The theme gallery and "More appearance options" are bespoke, not
      // rows, so their vocabulary lands on the page.
      "theme",
      "dark mode",
      "light mode",
      "color scheme",
      "palette",
      "preset",
      "gruvbox",
      "nord",
      "tokyo night",
      "everforest",
      "github",
      "prompt font",
      "ligatures",
      "panel animations",
      "contrast",
    ],
  },
  {
    section: "appearance",
    anchor: "appearance-interface",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Interface",
    description: null,
    group: null,
    keywords: ["layout", "chrome", "controls"],
  },
  {
    section: "appearance",
    anchor: "appearance-zoom",
    kind: "setting",
    availableWhen: isZoomRowAvailable,
    label: "Zoom",
    description: "Scales the whole app; font sizes only adjust typography.",
    group: "Interface",
    keywords: ["scale", "size", "bigger", "smaller", "magnify", "display"],
  },
  {
    section: "appearance",
    anchor: "appearance-pointer-cursors",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Use pointer cursors",
    description:
      "Change the cursor to a pointer when hovering over interactive elements.",
    group: "Interface",
    keywords: ["cursor", "mouse", "hand", "hover"],
  },
  {
    section: "appearance",
    anchor: "appearance-minimap-side",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Minimap side",
    description:
      "Place chat and artifact minimaps on the left or right, or hide both.",
    group: "Interface",
    keywords: ["minimap", "overview", "left", "right", "hide"],
  },
  {
    section: "appearance",
    anchor: "appearance-typography",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Typography",
    description: null,
    group: null,
    keywords: ["font", "text", "size", "typeface"],
  },
  {
    section: "appearance",
    anchor: "appearance-ui-font",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "UI font",
    description: "Font and size used across the Traycer interface.",
    group: "Typography",
    keywords: ["font", "typeface", "text size", "interface"],
  },
  {
    section: "appearance",
    anchor: "appearance-code-font",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Code font",
    description: "Font and size used for code across agents and diffs.",
    group: "Typography",
    keywords: ["font", "monospace", "mono", "diff", "editor"],
  },
  {
    section: "appearance",
    anchor: "appearance-terminal-group",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Terminal",
    description: null,
    group: null,
    keywords: ["shell", "console", "xterm"],
  },
  {
    section: "appearance",
    anchor: "appearance-terminal-font",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Terminal font",
    description:
      "Font and size used in the terminal. Follows the code font until you set them.",
    group: "Terminal",
    keywords: ["font", "monospace", "mono", "console", "xterm"],
  },
  {
    section: "appearance",
    anchor: "appearance-terminal-cursor",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Terminal cursor",
    description: "Shape of the cursor in the terminal.",
    group: "Terminal",
    keywords: ["cursor", "block", "bar", "underline", "caret"],
  },
  {
    section: "appearance",
    anchor: "appearance-blink-cursor",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Blink cursor",
    description: "Blink the terminal cursor while the terminal is focused.",
    group: "Terminal",
    keywords: ["blink", "flash", "cursor", "caret"],
  },
  {
    section: "appearance",
    anchor: "appearance-artifact-icons",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Artifact icons",
    description: null,
    group: null,
    keywords: ["icons", "artifacts", "files", "color"],
  },
  {
    section: "appearance",
    anchor: "appearance-artifact-icon-colors",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Artifact icon colors",
    description: "Turn on type-specific colors, or leave node icons neutral.",
    group: "Artifact icons",
    keywords: ["icons", "color", "file type", "monochrome", "neutral"],
  },

  // ------------------------------------------------------- Opening behavior
  {
    section: "opening-behavior",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Opening behavior",
    description: "Where links and tiles land when you open them.",
    group: null,
    keywords: ["open", "click", "navigate", "placement", "target"],
  },
  {
    section: "opening-behavior",
    anchor: "opening-links",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Links",
    description: null,
    group: null,
    keywords: ["url", "hyperlink", "external", "browser"],
  },
  // The four per-kind link rows (Markdown, Terminal, GitHub, Images) are NOT
  // indexed, and neither are the three per-category tile rows. They render
  // only while their parent row is set to "per-kind" / "per-category", which
  // is not the default — so an anchor naming one would resolve to nothing on
  // most installs, which is the one outcome worse than landing on the page.
  // Their vocabulary rides on the parent row instead: a hit on "github link"
  // lands on "Open links", which is the control that has to change first
  // anyway before a per-kind row exists to change second.
  {
    section: "opening-behavior",
    anchor: "opening-links-default",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Open links",
    description: null,
    group: "Links",
    keywords: [
      "url",
      "external",
      "in app",
      "default browser",
      "per kind",
      "markdown",
      "terminal",
      "github",
      "pull request",
      "images",
      "lightbox",
    ],
  },
  {
    section: "opening-behavior",
    anchor: "opening-tile-placement",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Tile placement",
    description: null,
    group: null,
    keywords: ["split", "pane", "layout", "window", "tab"],
  },
  {
    section: "opening-behavior",
    anchor: "opening-tiles-default",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Open new tiles",
    description: null,
    group: "Tile placement",
    keywords: [
      "split",
      "pane",
      "replace",
      "new tab",
      "layout",
      "per category",
      "files",
      "diffs",
      "artifacts",
      "agents",
      "terminals",
      "browsers",
    ],
  },
  {
    section: "opening-behavior",
    anchor: "opening-tiles-agent-opened",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Agent-opened tabs",
    description:
      "When an agent or a page opens a browser tab without you clicking anything.",
    group: "Tile placement",
    keywords: ["agent", "popup", "automatic", "background", "browser"],
  },

  // --------------------------------------------- Notifications (application)
  {
    section: "app-notifications",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Sounds",
    description: "How this app alerts you across hosts.",
    group: null,
    keywords: [
      "notifications",
      "alerts",
      "banner",
      "push",
      // The chime group carries no heading of its own (the page names it),
      // so its vocabulary lands here.
      "sound",
      "chime",
      "audio",
      "beep",
      "volume",
      "mute",
      "ding",
    ],
  },
  {
    section: "app-notifications",
    anchor: "app-notifications-events",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Events",
    description: null,
    group: null,
    keywords: ["alerts", "triggers", "when"],
  },
  {
    section: "app-notifications",
    anchor: "app-notification-events",
    kind: "setting",
    availableWhen: alwaysAvailable,
    label: "Notification events",
    description:
      "Choose which events alert you for the host selected in Settings.",
    group: "Events",
    keywords: ["events", "turn done", "alerts", "filter", "which"],
  },
  {
    section: "app-notifications",
    anchor: "app-notifications-system",
    kind: "group",
    availableWhen: isSystemNotificationsGroupAvailable,
    label: "System",
    description: null,
    group: null,
    keywords: ["os", "native", "banner", "badge"],
  },
  {
    section: "app-notifications",
    anchor: "app-notifications-os",
    kind: "setting",
    availableWhen: isSystemNotificationsGroupAvailable,
    label: "OS notifications",
    description:
      "Banners, badges, and delivery are managed by your operating system.",
    group: "System",
    keywords: ["os", "native", "banner", "badge", "macos", "windows"],
  },
  {
    section: "app-notifications",
    anchor: "app-notifications-this-phone",
    kind: "group",
    availableWhen: isPushPermissionGroupAvailable,
    label: "This phone",
    description: null,
    group: null,
    keywords: ["mobile", "ios", "android", "device", "push"],
  },
  {
    section: "app-notifications",
    anchor: "app-notifications-push",
    kind: "setting",
    availableWhen: isPushPermissionGroupAvailable,
    label: "Push notifications",
    description: null,
    group: "This phone",
    keywords: ["push", "mobile", "phone", "permission", "remote"],
  },

  // ------------------------------------------------------------ Keybindings
  {
    section: "keybindings",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Keybindings",
    description: "Every chord the app listens for, and how to rebind it.",
    group: null,
    keywords: [
      "shortcut",
      "shortcuts",
      "hotkey",
      "chord",
      "keyboard",
      "rebind",
      "key",
      "accelerator",
      "leader",
    ],
  },

  // ------------------------------------------------ Diagnostics (application)
  {
    section: "app-diagnostics",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Diagnostics",
    description:
      "Logging and memory capture for the Traycer app itself - this window, whichever host it points at.",
    group: null,
    keywords: [
      "logs",
      "debug",
      "troubleshoot",
      "verbose",
      "renderer",
      "app",
      "support",
    ],
  },
  {
    section: "app-diagnostics",
    anchor: "app-diagnostics-log-detail",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Log detail",
    description: null,
    group: null,
    keywords: ["verbosity", "level", "debug", "trace", "logging", "info"],
  },
  {
    section: "app-diagnostics",
    anchor: "app-diagnostics-memory",
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Memory",
    description: null,
    group: null,
    keywords: ["heap", "ram", "leak", "usage", "snapshot"],
  },

  // --------------------------------------------------------------- Sessions
  {
    section: "devices",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Sessions",
    description:
      "Review where your account is signed in and remove access you no longer recognize.",
    group: null,
    keywords: [
      "devices",
      "sign out",
      "logout",
      "security",
      "account",
      "revoke",
      "login",
    ],
  },

  // -------------------------------------------------------- Link mobile app
  {
    section: "link-phone",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Link mobile app",
    description: "Sign the Traycer mobile app in by scanning this code.",
    group: null,
    keywords: [
      "phone",
      "mobile",
      "qr",
      "pair",
      "link",
      "ios",
      "android",
      "code",
      "scan",
    ],
  },

  // ------------------------------------------------------------------ Usage
  {
    section: "usage",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Usage",
    description: "Token and cost usage across your agents.",
    group: null,
    keywords: [
      "tokens",
      "cost",
      "spend",
      "billing",
      "credits",
      "quota",
      "analytics",
    ],
  },

  // --------------------------------------------------------------- Overview
  // No host-scoped section indexes an anchor: every group on those pages is
  // dropped or concealed for an unresolved, connecting or vanished host, so
  // only the page itself is a stable destination. What the Overview's cards
  // and rows are called — Installation, Data & migration, Danger zone, and
  // whichever removal verb the selected host has — rides on this entry.
  {
    section: "host",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Overview",
    description: "The selected host's status, version, and installation.",
    group: null,
    keywords: [
      "host",
      "status",
      "version",
      "update",
      "upgrade",
      "restart",
      "service",
      "machine",
      "server",
      "connection",
      "rename",
      "installation",
      "install",
      "path",
      "binary",
      "data & migration",
      "import your work",
      "import",
      "migration",
      "migrate",
      "transfer",
      "cloud",
      "danger zone",
      "remove",
      "uninstall",
      "remove traycer",
      "delete",
      "deregister",
      "remove from account",
      "unlink",
      "file edit snapshots",
      "snapshots",
      "undo",
      "disk space",
      "cache",
    ],
  },

  // -------------------------------------------------------------- Providers
  {
    section: "providers",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Providers",
    description: "Coding agents, their accounts, models, and extensions.",
    group: null,
    keywords: [
      "claude",
      "codex",
      "cursor",
      "grok",
      "amp",
      "harness",
      "cli",
      "sign in",
      "auth",
      "login",
      "agent",
    ],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "API key",
    description: "The key a provider authenticates with.",
    group: "Providers",
    keywords: ["api key", "token", "secret", "credential", "auth"],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Profiles & limits",
    description: "Managed profiles and remaining rate limits per provider.",
    group: "Providers",
    keywords: [
      "profile",
      "subscription",
      "rate limit",
      "quota",
      "usage limits",
      "account",
    ],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "MCP servers",
    description: "Model Context Protocol servers, per provider.",
    group: "Providers",
    keywords: ["mcp", "model context protocol", "server", "tools", "connector"],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Model providers",
    description: "Which upstream models a provider can reach.",
    group: "Providers",
    keywords: ["model", "openrouter", "custom model", "endpoint", "base url"],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Skills",
    description: "Skills installed into a provider.",
    group: "Providers",
    keywords: ["skill", "skills", "playbook", "install"],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Plugins",
    description: "Plugins installed into a provider.",
    group: "Providers",
    keywords: ["plugin", "plugins", "extension", "marketplace"],
  },
  {
    section: "providers",
    anchor: null,
    kind: "group",
    availableWhen: alwaysAvailable,
    label: "Environment variables",
    description: "Per-provider environment overrides.",
    group: "Providers",
    keywords: ["env", "environment", "variable", "override", "secret", "proxy"],
  },

  // -------------------------------------------------------------- Worktrees
  {
    section: "worktrees",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Worktrees",
    description: "Traycer-created worktrees on this host.",
    group: null,
    keywords: [
      "git",
      "branch",
      "checkout",
      "clone",
      "repo",
      "repository",
      "prune",
      "delete",
      "setup script",
      "teardown",
      "disk space",
    ],
  },

  // --------------------------------------------------- Notifications (host)
  {
    section: "notifications",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Notifications",
    description: "What this host surfaces, and what its automation receives.",
    group: null,
    // Its two groups are not indexed on their own: the page's scope gate
    // conceals them while the host connects or is unreachable and drops them
    // for a host that vanished. Their words land on the page instead.
    keywords: [
      "alerts",
      "filter",
      "automation",
      "host",
      "in-app notifications",
      "toast",
      "severity",
      "notification hooks",
      "hooks",
      "webhook",
      "script",
      "command",
      "trigger",
      "run on",
    ],
  },

  // -------------------------------------------------------- Agent selection
  {
    section: "agents",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Agent selection",
    description:
      "How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents.",
    group: null,
    keywords: [
      "agents",
      "guide",
      "instructions",
      "model",
      "reasoning",
      "effort",
      "delegation",
      "child agent",
      "routing",
    ],
  },

  // --------------------------------------------------------------- Fallback
  {
    section: "fallback",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Fallback",
    description: "When a turn fails on a provider error, try these in order.",
    group: null,
    // Nothing below the page is indexed on its own: the page's scope gate
    // conceals its groups while the host connects or cannot be reached, and
    // every group renders only once the host answers the policy read. Their
    // words land on the page instead - the master switch's included, whose
    // row reads "Automatic fallback".
    keywords: [
      "automatic",
      "rate limit",
      "usage limit",
      "limit reached",
      "session limit",
      "switch account",
      "switch model",
      "failover",
      "backup model",
      "recovery",
      "retry",
      "outage",
      "wait for reset",
      "grace period",
      "countdown",
      "equivalent models",
      "similar model",
      "tier",
      "allowed destinations",
      "exclude provider",
      "per-failure overrides",
      "reset",
    ],
  },

  // ------------------------------------------------------------------ Shell
  // The page's two cards are not indexed on their own: both are replaced by a
  // notice for a remote host too old to answer the shell config RPC, and by a
  // no-source notice for this computer's host with no CLI bridge. What was
  // their vocabulary rides on the page, which renders for every host.
  {
    section: "shell",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Shell",
    description:
      "How Traycer launches terminals, the host, and provider harnesses.",
    group: null,
    keywords: [
      "terminal",
      "bash",
      "zsh",
      "fish",
      "powershell",
      "console",
      "terminal shell",
      "new terminals",
      "shell program",
      "startup flags",
      "flags",
      "arguments",
      "wsl",
      "host environment",
      "env",
      "environment variables",
      "path",
      "proxy",
      "node options",
      "after restart",
    ],
  },

  // ---------------------------------------------------- Diagnostics (host)
  // Its Log detail card is not indexed on its own: it is dropped for a host
  // too old to answer the log-level RPC. The words reach the page instead.
  {
    section: "diagnostics",
    anchor: null,
    kind: "section",
    availableWhen: alwaysAvailable,
    label: "Diagnostics",
    description:
      "Log verbosity and recent log output for the host selected above.",
    group: null,
    keywords: [
      "logs",
      "debug",
      "verbose",
      "troubleshoot",
      "host",
      "cli",
      "support",
      "log file",
      "log detail",
      "log level",
      "cli log level",
      "host log level",
      "verbosity",
      "trace",
      "logging",
    ],
  },
];
