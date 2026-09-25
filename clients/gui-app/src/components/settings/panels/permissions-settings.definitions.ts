import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// No host-GATED element carries an anchor (SETTINGS.md § Search); a tab trigger
// is not gated. The page's four tab triggers are always rendered - the tab bar
// sits above `HostScopeGate`, which wraps only the Judge, Rules and Activity
// BODIES - so each tab anchors on its trigger, and a search that lands there
// opens the tab. Everything inside a gated body (a host that predates Auto
// mode, or a scope that is connecting, unreachable or vanished, renders none of
// it) contributes to its tab's trigger instead. The Modes row is the one row
// with an anchor of its own: its tab is not gated, because the setting is
// app-wide.
export const PERMISSIONS = defineSettingsSection("permissions", {
  page: {
    label: "Permissions",
    description:
      "How much an agent may do on its own, and who reviews the rest.",
    keywords: ["permissions", "approve", "approval", "ask before"],
  },
  modesTab: {
    kind: "group",
    search: { anchor: "permissions-tab-modes" },
    label: "Modes",
    description:
      "The mode a new conversation starts in, and what each mode runs without asking.",
    breadcrumb: "Permissions",
    availableWhen: alwaysAvailable,
    keywords: [
      "modes",
      "supervised",
      "auto-accept edits",
      "accept edits",
      "auto",
      "full access",
      "runs without asking",
    ],
  },
  judgeTab: {
    kind: "group",
    search: { anchor: "permissions-tab-judge" },
    label: "Judge",
    description: "The model that reviews commands in Auto mode.",
    breadcrumb: "Permissions",
    availableWhen: alwaysAvailable,
    keywords: ["judge", "reviewer", "who reviews"],
  },
  rulesTab: {
    kind: "group",
    search: { anchor: "permissions-tab-rules" },
    label: "Rules",
    description: "Your Auto mode rules, on top of Traycer's built-in ones.",
    breadcrumb: "Permissions",
    availableWhen: alwaysAvailable,
    keywords: ["rules", "policy", "auto mode policy"],
  },
  activityTab: {
    kind: "group",
    search: { anchor: "permissions-tab-activity" },
    label: "Activity",
    description: "What the judge decided recently on this machine.",
    breadcrumb: "Permissions",
    availableWhen: alwaysAvailable,
    keywords: ["activity", "recent decisions", "history", "log"],
  },
  // The card the Modes row renders in. A contributor, not the tab's own group:
  // the tab's anchor is on its TRIGGER, and a card carrying it too would give
  // one result two targets.
  startingMode: {
    kind: "group",
    search: { contributesTo: "modesTab" },
    label: "Modes",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["default mode", "starting mode"],
  },
  // Moved here from General ▸ Chat & composer, with General's search
  // vocabulary: nothing stores an anchor token, so General keeps no alias and
  // "default permission" lands on this row by its keywords alone. Application
  // scope inside a host-scoped page - the one exception the page makes, which
  // is why its tab is not gated and the row carries an "All machines" badge.
  defaultPermission: {
    kind: "row",
    group: "startingMode",
    search: { anchor: "permissions-default-permission-mode" },
    label: "New conversations start in",
    description: "Any conversation can change its own mode from the composer.",
    availableWhen: alwaysAvailable,
    keywords: [
      "default permission",
      "default permission mode",
      "permission mode",
      "new chat",
      "new conversation",
      "permissions",
      "approval",
      "approve",
      "auto mode",
      "plan mode",
      "accept edits",
      "full access",
      "supervised",
    ],
  },
  modeCards: {
    kind: "group",
    search: { contributesTo: "modesTab" },
    label: "What each mode runs without asking",
    description: null,
    breadcrumb: "Modes",
    availableWhen: alwaysAvailable,
    keywords: ["reads", "edits", "commands", "unreviewed"],
  },
  autoModeJudge: {
    kind: "group",
    search: { contributesTo: "judgeTab" },
    label: "Auto mode judge",
    description: "Checks each command before it runs in Auto mode.",
    breadcrumb: "Judge",
    availableWhen: alwaysAvailable,
    keywords: [
      "auto mode judge",
      "classifier",
      "automatic",
      "pick a model",
      "recommended",
      "model",
      "provider",
      "account",
      "credits",
      "inference",
      "premium requests",
      "copilot",
    ],
  },
  ruleSections: {
    kind: "group",
    search: { contributesTo: "rulesTab" },
    label: "Your rules",
    description:
      "Your rules go on top of Traycer's built-in ones and apply to your account on every machine.",
    breadcrumb: "Rules",
    availableWhen: alwaysAvailable,
    keywords: [
      "environment",
      "always allow",
      "allow rule",
      "allow",
      "ask first",
      "never allow",
      "deny",
      "soft deny",
      "hard deny",
      "notes",
      "auto-policy.md",
    ],
  },
  builtInRules: {
    kind: "group",
    search: { contributesTo: "rulesTab" },
    label: "Built-in rules",
    description: "Built-in rules come with each machine's Traycer version.",
    breadcrumb: "Rules",
    availableWhen: alwaysAvailable,
    keywords: [
      "built-in rules",
      "default rules",
      "always asks",
      "blocked",
      "what the judge blocks",
    ],
  },
  recentDecisions: {
    kind: "group",
    search: { contributesTo: "activityTab" },
    label: "Recent decisions",
    description: null,
    breadcrumb: "Activity",
    availableWhen: alwaysAvailable,
    keywords: [
      "allowed",
      "asked you",
      "refused",
      "couldn't decide",
      "verdict",
      "decisions",
    ],
  },
});

/** The page's tabs, in order. The open intent's `tab` names one of these. */
export const PERMISSIONS_TABS = [
  "modes",
  "judge",
  "rules",
  "activity",
] as const;

export type PermissionsTab = (typeof PERMISSIONS_TABS)[number];

export function isPermissionsTab(
  value: string | null,
): value is PermissionsTab {
  return PERMISSIONS_TABS.some((tab) => tab === value);
}

/** The tab-trigger group each tab anchors on. */
export const PERMISSIONS_TAB_GROUPS = {
  modes: PERMISSIONS.definitions.modesTab,
  judge: PERMISSIONS.definitions.judgeTab,
  rules: PERMISSIONS.definitions.rulesTab,
  activity: PERMISSIONS.definitions.activityTab,
} as const;

/**
 * The tab a settings-search landing opens: a tab trigger's anchor names its
 * tab, and the Modes row lives on Modes. `null` for an anchor on no tab.
 */
export function permissionsTabForAnchor(
  anchor: string | null,
): PermissionsTab | null {
  if (anchor === null) return null;
  if (anchor === PERMISSIONS.definitions.defaultPermission.anchor) {
    return "modes";
  }
  return (
    PERMISSIONS_TABS.find(
      (tab) => PERMISSIONS_TAB_GROUPS[tab].anchor === anchor,
    ) ?? null
  );
}
