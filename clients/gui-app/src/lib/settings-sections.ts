import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  GitBranch,
  Keyboard,
  LineChart,
  Palette,
  PanelsTopLeft,
  QrCode,
  Server,
  ShieldCheck,
  Settings as SettingsIcon,
  TerminalSquare,
} from "lucide-react";
import { isMobileApp } from "@/lib/mobile-app";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "opening-behavior"
  | "app-notifications"
  | "providers"
  | "notifications"
  | "agents"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host"
  | "devices"
  | "link-phone"
  // Two sections, both labelled "Diagnostics", and the group they sit in is what distinguishes them - `app-diagnostics` is this window's own logging and heap, `diagnostics` is the selected host's.
  | "app-diagnostics"
  | "diagnostics"
  | "usage";

/** What a section BELONGS to - the organising idea of the whole surface. */
export type SettingsSectionGroupId = "app" | "account" | "host";

export interface SettingsSectionGroup {
  readonly id: SettingsSectionGroupId;
  readonly label: string;
}

/**
 * Application and Account lead: both are short, both are fixed, and neither ever changes shape, so they hold stable positions at the top of the rail.
 * The host group goes last because it is the only one whose contents are scoped - it carries the picker, and everything beneath the picker belongs to whichever host that picker names.
 */
export const SETTINGS_SECTION_GROUPS: ReadonlyArray<SettingsSectionGroup> = [
  { id: "app", label: "Application" },
  { id: "account", label: "Account" },
  { id: "host", label: "Host" },
];

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: SettingsSectionGroupId;
}

// No `requiresLocalHost` flag any more.
// It marked Shell and Diagnostics as reachable only while the selected host was the one running on this computer, because both were backed by the on-disk config store through the local CLI bridge.

/**
 * Order is meaningful twice over: it drives the leader-digit shortcuts (`dispatch.ts` indexes positionally, through `visibleSettingsSections()` below, which preserves this order) and it groups the sidebar.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: "general",
    label: "General",
    icon: SettingsIcon,
    group: "app",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "app",
  },
  // Where a click LANDS - links, tile placement, and agent-opened browser tabs.
  // One page rather than a control each in Browser, Appearance and General, because all three answer the same question.
  {
    id: "opening-behavior",
    label: "Opening behavior",
    icon: PanelsTopLeft,
    group: "app",
  },
  // Application and Host intentionally both have a Notifications page.
  // The group heading states the scope: this one owns renderer sound and the phone's OS permission; the host one owns filtering and automation.
  {
    id: "app-notifications",
    label: "Notifications",
    icon: Bell,
    group: "app",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Keyboard,
    group: "app",
  },
  // Application, not Host, and it is the same word as the host section on purpose: both pages ARE diagnostics, and the group heading above each is what says whose.
  // The split exists because this half never varied by host - the app's log verbosity, its log file and its heap describe one window - so under the picker it was drawn once per host in the account, offering the same single setting from N places.
  {
    id: "app-diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "app",
  },
  {
    id: "devices",
    label: "Sessions",
    icon: ShieldCheck,
    group: "account",
  },
  // Account, like Sessions: the code it mints signs the PHONE into the
  // account, regardless of which host this window looks at.
  {
    id: "link-phone",
    label: "Link mobile app",
    icon: QrCode,
    group: "account",
  },
  // Account, not Host: what this reports is the ACCOUNT's token and cost spend, with the host as one filter INSIDE the page (defaulting to all of them).
  // Under the sidebar's host picker it would have put two competing host scopes on one screen, with the outer one unable to describe the number the inner one produced.
  {
    id: "usage",
    label: "Usage",
    icon: LineChart,
    group: "account",
  },
  // The host group. Everything here is scoped by the picker that heads it.
  {
    id: "host",
    label: "Overview",
    icon: Server,
    group: "host",
  },
  {
    id: "providers",
    label: "Providers",
    icon: Boxes,
    group: "host",
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: GitBranch,
    group: "host",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    group: "host",
  },
  // "Agent selection", not "Agents": this section configures HOW a coding agent and model get chosen when spawning child agents.
  // It does not manage the Agents that live in a Task, and the old label collided with that surface.
  {
    id: "agents",
    label: "Agent selection",
    icon: Bot,
    group: "host",
  },
  {
    id: "shell",
    label: "Shell",
    icon: TerminalSquare,
    group: "host",
  },
  // The host half: `cli`/`host` log verbosity and that machine's own log files.
  // Everything left here answers differently per host, which is what earns it a place under the picker.
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "host",
  },
];

/**
 * Sections the installed mobile app does not offer.
 * Two different reasons sit here, and the difference is worth keeping straight:
 */
const MOBILE_APP_OMITTED_SECTION_IDS: ReadonlySet<SettingsSectionId> = new Set([
  "keybindings",
  "link-phone",
]);

/** The sections a build OFFERS, as opposed to the ones it can resolve. */
export function visibleSettingsSections(): ReadonlyArray<SettingsSection> {
  if (!isMobileApp()) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter(
    (section) => !MOBILE_APP_OMITTED_SECTION_IDS.has(section.id),
  );
}

/**
 * Whether this build offers `sectionId` at all.
 * A surface holding a REMEMBERED id (a persisted modal section, a restored tab path) asks this before showing the panel for it, so a build that dropped a section cannot present a panel its own navigation has no row for.
 */
export function isSettingsSectionVisible(
  sectionId: SettingsSectionId,
): boolean {
  return visibleSettingsSections().some((section) => section.id === sectionId);
}

// No `HOST_SCOPED_SECTION_IDS` / `isHostScopedSection` helper here.
// Whether a section is host-scoped is already stated by `group: "host"` in the table above, and the sidebar is the only thing that asks.
