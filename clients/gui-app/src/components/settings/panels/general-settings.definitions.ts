import { modLabel } from "@/lib/keybindings/platform";
import {
  alwaysAvailable,
  isAgentRolesRowAvailable,
  isHostLifecycleRowAvailable,
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
    availableWhen: alwaysAvailable,
    label: "General",
    description: "App behavior, agent activity, and local data controls.",
    keywords: ["preferences", "options", "misc"],
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
      "Dictate prompts with the mic button or its shortcut. The microphone opens only while you are dictating, and turning this off closes it. Speech is transcribed on-device - audio never leaves your machine.",
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
  // One group for everything about running agents. Each of its rows used to
  // have a heading and a card of its own (Running agents, When you quit
  // Traycer, Worktrees, Experimental), which drew four borders around four
  // settings. Every row is gated on its own, and the branch prefix is drawn in
  // every shell, so the group never renders empty.
  agents: {
    kind: "group",
    search: { anchor: "general-agents" },
    label: "Agents",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["activity", "background", "running agents", "worktrees"],
  },
  preventSleep: {
    kind: "row",
    group: "agents",
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
  // Machine-local, so it lives here rather than under a host scope: it has to
  // work before any host is installed and with no local host. Signed out this
  // page is not reachable; the full card renders on its own at
  // `/when-you-quit`. The row shows the chosen mode's own sentence as its
  // `status`, so this description is what search reads.
  hostLifecycle: {
    kind: "row",
    group: "agents",
    search: { anchor: "general-host-lifecycle" },
    label: "When you quit Traycer",
    description:
      "Choose what happens to the host on this machine when you quit: keep it running in the background, ask each time, stop it if idle, stop it with the app, or don't run a host here.",
    availableWhen: isHostLifecycleRowAvailable,
    keywords: [
      "quit",
      "host",
      "background",
      "keep running",
      "stop host",
      "linked",
      "lifecycle",
      "login",
      "ask",
      "idle",
      "remote",
      "wsl",
      "no local host",
    ],
  },
  // The same setting drawn as a card of its own at `/when-you-quit`, the one
  // page a signed-out desktop can reach. It has no entry: settings search does
  // not exist there, and signed in the row above is where a result lands.
  hostLifecycleCard: {
    kind: "group",
    search: { contributesTo: "hostLifecycle" },
    label: "When you quit Traycer",
    description: null,
    breadcrumb: null,
    availableWhen: isHostLifecycleRowAvailable,
    keywords: [],
  },
  // Its sentence embeds a live preview of the next branch name, so the row
  // passes it as a `status` and the keywords carry the vocabulary.
  branchPrefix: {
    kind: "row",
    group: "agents",
    search: { anchor: "general-branch-prefix" },
    label: "Worktree branch prefix",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: ["branch", "naming", "prefix", "git", "worktree", "checkout"],
  },
  agentRoles: {
    kind: "row",
    group: "agents",
    search: { anchor: "general-agent-roles" },
    label: "Agent roles",
    description:
      "Let agents claim durable responsibilities and coordinate through role-aware tools and prompts.",
    availableWhen: isAgentRolesRowAvailable,
    keywords: [
      "roles",
      "coordination",
      "delegation",
      "feature flag",
      "experimental",
      "beta",
      "preview",
      "labs",
    ],
  },
  // Gated on the SELECTED HOST (both `chatAutoArchive.*` methods advertised),
  // which no shell-level predicate can decide, so it has no entry of its own:
  // its label and keywords fold into the Agents group, a destination drawn in
  // every shell (SETTINGS.md, "A result must land somewhere").
  chatAutoArchive: {
    kind: "row",
    group: "agents",
    search: { contributesTo: "agents" },
    label: "Archive idle agents automatically",
    description:
      "Tidy up chats agents started once they go quiet. Applies on all your hosts.",
    availableWhen: alwaysAvailable,
    keywords: ["archive", "idle", "inactive", "auto", "cleanup", "timer"],
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
