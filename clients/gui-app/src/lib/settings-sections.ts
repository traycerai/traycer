import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  GitBranch,
  Keyboard,
  Palette,
  Server,
  ShieldCheck,
  Settings as SettingsIcon,
  TerminalSquare,
} from "lucide-react";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "providers"
  | "notifications"
  | "agents"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host"
  | "devices"
  | "diagnostics";

/**
 * What a section BELONGS to — the organising idea of the whole surface.
 *
 * Settings used to be one flat list in which "Appearance" (this app),
 * "Sessions" (your account) and "Providers" (one specific machine) were
 * indistinguishable peers. Nothing said which of them followed you between
 * machines, and four sections quietly grew their own host dropdown to cover
 * for it.
 *
 * Grouping makes the scope structural instead of memorised: the `host` group
 * is headed by the one host switcher, and everything in it is scoped by that
 * selection. The rule becomes "if it varies by machine it sits under the
 * switcher" rather than "memorise five exceptions".
 */
export type SettingsSectionGroupId = "app" | "account" | "host";

export interface SettingsSectionGroup {
  readonly id: SettingsSectionGroupId;
  /** `null` for the host group — the switcher itself is its header. */
  readonly label: string | null;
}

export const SETTINGS_SECTION_GROUPS: ReadonlyArray<SettingsSectionGroup> = [
  { id: "app", label: "App" },
  { id: "account", label: "Account" },
  { id: "host", label: null },
];

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: SettingsSectionGroupId;
  /**
   * A section that can only ever act on the machine the app is running on,
   * because it is backed by a local bridge / the local CLI rather than a host
   * RPC. It sits in the `app` group but says so, instead of leaving the reader
   * to wonder whether it followed the host switcher.
   */
  readonly thisMachineOnly: boolean;
}

/**
 * Order is meaningful twice over: it drives the leader-digit shortcuts
 * (`dispatch.ts` indexes straight into this array) and it groups the sidebar.
 * Entries must stay contiguous per group or the sidebar renders a group
 * heading twice.
 *
 * Section `id`s are a compatibility surface — routes (`/settings/<id>`), the
 * settings-modal switch, the command palette and remembered tab paths all key
 * off them — so ids never change even when labels do.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: "general",
    label: "General",
    icon: SettingsIcon,
    group: "app",
    thisMachineOnly: false,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "app",
    thisMachineOnly: false,
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Keyboard,
    group: "app",
    thisMachineOnly: false,
  },
  // Shell and Diagnostics are backed by the local CLI / desktop bridges, not
  // by a host RPC, so they cannot target a picked host at all. They stay out
  // of the host group rather than sitting under a switcher they would ignore
  // — the precise failure that made the old flat list untrustworthy.
  {
    id: "shell",
    label: "Shell",
    icon: TerminalSquare,
    group: "app",
    thisMachineOnly: true,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "app",
    thisMachineOnly: true,
  },
  {
    id: "devices",
    label: "Sessions",
    icon: ShieldCheck,
    group: "account",
    thisMachineOnly: false,
  },
  // The host group. Everything below the switcher is scoped by it.
  {
    id: "host",
    label: "Overview",
    icon: Server,
    group: "host",
    thisMachineOnly: false,
  },
  {
    id: "providers",
    label: "Providers",
    icon: Boxes,
    group: "host",
    thisMachineOnly: false,
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: GitBranch,
    group: "host",
    thisMachineOnly: false,
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    group: "host",
    thisMachineOnly: false,
  },
  // "Agent selection", not "Agents": this section configures HOW a coding agent
  // and model get chosen when spawning child agents. It does not manage the
  // Agents that live in a Task, and the old label collided with that surface.
  // The section `id` (and its `/settings/agents` route) is an internal
  // identifier on the compatibility boundary and stays put.
  {
    id: "agents",
    label: "Agent selection",
    icon: Bot,
    group: "host",
    thisMachineOnly: false,
  },
];

/** Sections scoped by the host switcher, in sidebar order. */
export const HOST_SCOPED_SECTION_IDS: ReadonlySet<SettingsSectionId> = new Set(
  SETTINGS_SECTIONS.filter((section) => section.group === "host").map(
    (section) => section.id,
  ),
);

export function isHostScopedSection(id: SettingsSectionId): boolean {
  return HOST_SCOPED_SECTION_IDS.has(id);
}
