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
  | "diagnostics"
  | "usage";

/**
 * What a section BELONGS to — the organising idea of the whole surface.
 *
 * Settings used to be one flat list in which "Appearance" (this app),
 * "Sessions" (your account) and "Providers" (one specific host) were
 * indistinguishable peers. Nothing said which of them followed you between
 * hosts, and four sections quietly grew their own host dropdown to cover for
 * it.
 *
 * The fix is a SCOPE, not a level. Settings has already spent its nesting
 * budget inside Providers — that panel is a rail plus a per-provider tab bar,
 * so the sidebar itself gets exactly one level and the host cannot become
 * another one. The host group is therefore headed by ONE picker, and
 * everything under it is scoped by that pick. Depth stays flat; the rule ("if
 * it varies by host it sits under the picker") becomes structural rather than
 * memorised.
 */
export type SettingsSectionGroupId = "app" | "account" | "host";

export interface SettingsSectionGroup {
  readonly id: SettingsSectionGroupId;
  readonly label: string;
}

/**
 * Application and Account lead: both are short, both are fixed, and neither
 * ever changes shape, so they hold stable positions at the top of the rail.
 * The host group goes last because it is the only one whose contents are
 * scoped — it carries the picker, and everything beneath the picker belongs
 * to whichever host that picker names.
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

// No `requiresLocalHost` flag any more. It marked Shell and Diagnostics as
// reachable only while the selected host was the one running on this computer,
// because both were backed by the on-disk config store through the local CLI
// bridge. `config.*` / `diagnostics.*` retired that limit: every section here
// reads the selected host over its own RPC, so no row can be unreachable for a
// reason the sidebar would have to encode. (The one surviving local path —
// this computer's host with its process stopped — is a per-panel FALLBACK that
// keeps those pages working, not a restriction on reaching them.)

/**
 * Order is meaningful twice over: it drives the leader-digit shortcuts
 * (`dispatch.ts` indexes straight into this array) and it groups the sidebar.
 * Entries must stay contiguous per group or the sidebar renders a group
 * heading twice.
 *
 * Only the first ten entries can carry a digit
 * (`SINGLE_DIGIT_LEADER_INDEX_LIMIT`); Shell and Diagnostics are the
 * eleventh and twelfth and go without, which are the right two to lose —
 * both are support surfaces and the rarest destinations here.
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
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "app",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Keyboard,
    group: "app",
  },
  {
    id: "devices",
    label: "Sessions",
    icon: ShieldCheck,
    group: "account",
  },
  // Account, not Host: what this reports is the ACCOUNT's token and cost
  // spend, with the host as one filter INSIDE the page (defaulting to all of
  // them). Under the sidebar's host picker it would have put two competing
  // host scopes on one screen, with the outer one unable to describe the
  // number the inner one produced. It still reads through a host client -
  // every RPC does - but that is a transport fact, not a scope one.
  //
  // Moving it here cost Shell its leader digit: the group must stay
  // contiguous (see this array's doc comment), so Usage had to land beside
  // Sessions rather than stay appended, and that pushes Shell past
  // `SINGLE_DIGIT_LEADER_INDEX_LIMIT` into the digit-less tail with
  // Diagnostics. Shell is the right one to lose it to - Diagnostics was
  // already there, and Usage is a far more frequent destination than either.
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
  },
  {
    id: "shell",
    label: "Shell",
    icon: TerminalSquare,
    group: "host",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "host",
  },
];

// No `HOST_SCOPED_SECTION_IDS` / `isHostScopedSection` helper here. Whether a
// section is host-scoped is already stated by `group: "host"` in the table
// above, and the sidebar is the only thing that asks. A derived Set plus a
// predicate over it was a second source for a fact the data already carries.
