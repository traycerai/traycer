import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  Cloud,
  Coins,
  FileText,
  GitBranch,
  ListChecks,
  Globe,
  Keyboard,
  KeyRound,
  LockKeyhole,
  MessageSquareDot,
  MousePointerClick,
  LineChart,
  Palette,
  Plug,
  PanelBottom,
  PanelsTopLeft,
  QrCode,
  Server,
  Sparkles,
  Wrench,
  ShieldCheck,
  Settings as SettingsIcon,
  TerminalSquare,
  Users,
  UserX,
  Volume2,
  Waypoints,
} from "lucide-react";
import { isMobileApp } from "@/lib/mobile-app";
import type { PreviewFeature } from "@traycer/protocol/auth/preview-features";

export type SettingsSectionId =
  | "dev-artifact-proof"
  | "dev-canvas-proof"
  | "getting-started"
  | "general"
  | "browser"
  | "browser-agent-access"
  | "appearance"
  | "layout"
  | "opening-behavior"
  | "app-notifications"
  | "alerts"
  | "providers"
  | "secrets"
  | "sandboxes"
  | "members"
  | "mcp-servers"
  | "skills"
  | "agent-definitions"
  | "machine-setup"
  | "notifications"
  | "permissions"
  | "agents"
  | "fallback"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host"
  | "devices"
  | "link-phone"
  | "delete-account"
  // Two sections, both labelled "Diagnostics", and the group they sit in is
  // what distinguishes them — `app-diagnostics` is this window's own logging
  // and heap, `diagnostics` is the selected host's. The host one keeps the
  // bare id because ids are a compatibility surface (see below) and it is the
  // one already in remembered tab paths and `/settings/diagnostics` bookmarks.
  | "app-diagnostics"
  | "diagnostics"
  | "usage"
  | "credits";

/**
 * The Fallback section's id, as a value.
 *
 * Exported because the chat surfaces link INTO this section from six places -
 * the grace card, the waiting card, the destination menu's empty state, the
 * attribution details, the error card and the return banner - each doing
 * `openSettings({ section: FALLBACK_SETTINGS_SECTION_ID })`. A bare `"fallback"`
 * at each of those sites would make a rename a set of silently dead links
 * rather than a compile error, and they are on the failure path, where nobody
 * would find them.
 *
 * `as const satisfies` rather than a `SettingsSectionId` annotation: the
 * annotation would widen the value to the whole union, and `openSettings` and
 * `settingsRouteOptions` both build a literal route path from it.
 */
export const FALLBACK_SETTINGS_SECTION_ID =
  "fallback" as const satisfies SettingsSectionId;

/**
 * What a section BELONGS to — the organising idea of the whole surface.
 *
 * One rule, said beside the map (the environments core flows' Settings map):
 * if it varies by computer it sits under the host picker; if it is a
 * configuration's (Personal's, a team's) it sits under Environment; if it is
 * about your account rather than your settings it sits under Account; the rest
 * is the app itself.
 *
 * The scopes are groups, not levels. Settings has already spent its nesting
 * budget inside Providers — that panel is a rail plus a per-provider tab bar,
 * so the sidebar itself gets exactly one level. Two groups carry a picker: the
 * Environment dropdown names the configuration its pages show
 * (`environment-picker.tsx`; Personal reads through the window's own host, a
 * Local row through that computer, via `usePersonalHostScope`), and the Host
 * picker names the machine its pages show. Account pages read through the
 * window's own host.
 */
export type SettingsSectionGroupId =
  | "guide"
  | "app"
  | "account"
  | "personal"
  | "host";

export interface SettingsSectionGroup {
  readonly id: SettingsSectionGroupId;
  readonly label: string;
}

/**
 * Getting started leads in its own group, followed by Application, Account
 * and Environment. The host group goes last because it is the only one whose
 * contents are scoped — it carries the picker, and everything beneath the
 * picker belongs to whichever host that picker names.
 */
export const SETTINGS_SECTION_GROUPS: ReadonlyArray<SettingsSectionGroup> = [
  { id: "guide", label: "Guide" },
  { id: "app", label: "Application" },
  { id: "account", label: "Account" },
  // The id stays `personal` (ids are a compatibility surface); the group is
  // the Environment dropdown's: its picker names the configuration the pages
  // below it show, Personal, a team, or a computer that has not moved.
  { id: "personal", label: "Environment" },
  { id: "host", label: "Host" },
];

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: SettingsSectionGroupId;
  /**
   * The preview feature this page is offered under, or `null` for none.
   * Required, so a page states it where it is added: an unreleased page left
   * out of a separate list was offered with its feature off (Credits).
   */
  readonly previewFeature: PreviewFeature | null;
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
 * (`dispatch.ts` indexes positionally, through `visibleSettingsSections()`
 * below, which preserves this order) and it groups the sidebar. Entries must
 * stay contiguous per group or the sidebar renders a group heading twice.
 *
 * Only the first ten entries can carry a digit
 * (`SINGLE_DIGIT_LEADER_INDEX_LIMIT`), and there are now twenty-seven on
 * desktop (twenty-eight with a team's Members). Getting started and the nine
 * Application entries take 1 to 9 and 0, so Sessions, the first Account
 * entry, goes without, and so does everything after it - the rest of Account,
 * all of Environment and the host group. The groups follow the design's
 * order, so shortcut order stays sidebar reading order and command-palette
 * row order.
 *
 * Section `id`s are a compatibility surface — routes (`/settings/<id>`), the
 * settings-modal panel table, the command palette and remembered tab paths key
 * off them — so ids never change even when labels do.
 *
 * The rail label names WHAT the page controls; the group heading names WHOSE
 * it is. Two pages that control the same thing at two scopes share word and
 * icon (Diagnostics). Two pages that control different things get different
 * words and icons (Sounds vs Notifications). Surfaces with no scope carrier
 * qualify the label themselves — report-issue route labels already do
 * ("App diagnostics" / "Host diagnostics"). The mobile header still shows
 * the bare section label; that case is unresolved, not an example of the rule.
 * Putting the group word into a row the heading already scopes is the
 * inconsistent move, not the consistent one.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: "getting-started",
    label: "Getting started",
    icon: ListChecks,
    group: "guide",
    previewFeature: null,
  },

  {
    id: "general",
    label: "General",
    icon: SettingsIcon,
    group: "app",
    previewFeature: null,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "app",
    previewFeature: null,
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    group: "app",
    previewFeature: null,
  },
  {
    id: "opening-behavior",
    label: "Opening behavior",
    icon: PanelsTopLeft,
    group: "app",
    previewFeature: null,
  },
  // Different controls than Account → Notifications, so a different word and
  // icon (see the rail-table rule above). The id `app-notifications` now names
  // a chimes-only page - the OS and push rows moved to Alerts below - and it
  // stays, because ids are a compatibility surface (routes, remembered tab
  // paths, analytics, the panel table).
  {
    id: "app-notifications",
    label: "Sounds",
    icon: Volume2,
    group: "app",
    previewFeature: null,
  },
  // How this app's alerts reach you: the OS's notification settings on the
  // desktop, the phone's push permission and severities in the mobile app.
  // Not "Notifications" and not the bell, which are Account → Notifications',
  // a page that controls different things.
  {
    id: "alerts",
    label: "Alerts",
    icon: MessageSquareDot,
    group: "app",
    previewFeature: null,
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Keyboard,
    group: "app",
    previewFeature: null,
  },
  // Where the app's own chrome SITS and how much of it shows - the status bar
  // first, the composer and the sidebar's own layout beside it later. It is a
  // page rather than a group inside Appearance because the controls answer
  // "where does this live", not "what does it look like", and because a
  // per-window rate-limit list needs room Appearance does not have.
  {
    id: "layout",
    label: "Layout",
    icon: PanelBottom,
    group: "app",
    previewFeature: null,
  },
  // Same kind of page as Host → Diagnostics, partitioned by scope, so the
  // same word and icon. The split exists because this half never varied by
  // host — the app's log verbosity, its log file and its heap describe one
  // window — so under the picker it was drawn once per host in the account.
  {
    id: "app-diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "app",
    previewFeature: null,
  },
  {
    id: "devices",
    label: "Sessions",
    icon: ShieldCheck,
    group: "account",
    previewFeature: null,
  },
  // Account, like Sessions: the code it mints signs the PHONE into the
  // account, regardless of which host this window looks at.
  {
    id: "link-phone",
    label: "Link mobile app",
    icon: QrCode,
    group: "account",
    previewFeature: null,
  },
  // Account, not Host: what this reports is the ACCOUNT's token and cost
  // spend, with the host as one filter INSIDE the page (defaulting to all of
  // them). Under the sidebar's host picker it would have put two competing
  // host scopes on one screen, with the outer one unable to describe the
  // number the inner one produced. It still reads through a host client -
  // every RPC does - but that is a transport fact, not a scope one.
  {
    id: "usage",
    label: "Usage",
    icon: LineChart,
    group: "account",
    previewFeature: null,
  },
  // Account, beside Usage: credits are the person's to add and spend. The
  // page is E8's (`panels/credits-settings-panel`).
  {
    id: "credits",
    label: "Credits",
    icon: Coins,
    group: "account",
    previewFeature: "environments",
  },
  // Event policy and automation for the account. Different controls than
  // Application → Sounds and Alerts, so it keeps the generic word and the
  // bell.
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    group: "account",
    previewFeature: null,
  },
  // Offered ONLY by the installed mobile app (`MOBILE_APP_ONLY_SECTION_IDS`
  // below). Last in its group because it is the group's one irreversible
  // action, and because appending it keeps Account contiguous without moving
  // a single desktop row: the desktop list does not contain it at all, so no
  // existing leader digit shifts there.
  {
    id: "delete-account",
    label: "Delete account",
    icon: UserX,
    group: "account",
    previewFeature: null,
  },
  // The Environment group (id `personal`): the configuration the Environment
  // dropdown picks. Personal's pages read through the window's own host and
  // what they save applies wherever the person signs in; a Local row's read
  // through that computer and hide what only a cloud configuration has
  // (`environmentSectionShown`).
  {
    id: "providers",
    label: "Providers",
    icon: Boxes,
    group: "personal",
    previewFeature: null,
  },
  // MCP servers and Skills were tabs inside each provider. They are pages of
  // their own because each entry is one of the person's settings: managed
  // entries follow them to every host, and a local one is added on a click.
  {
    id: "mcp-servers",
    label: "MCP servers",
    icon: Plug,
    group: "personal",
    previewFeature: null,
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    group: "personal",
    previewFeature: null,
  },
  // What an agent may do on its own: the mode a conversation starts in, the
  // judge that reviews actions under the `auto` permission mode, the rules it
  // follows, and what it decided. Its own page rather than rows on Agent
  // selection - that page is about which agent gets CHOSEN for a task, and
  // permissions are a different question. Under Environment because the
  // approval policy is the configuration's, whichever computer the agent runs
  // on.
  {
    id: "permissions",
    label: "Permissions",
    // A key, the common permissions glyph; a gavel at sidebar size read as a
    // broom.
    icon: KeyRound,
    group: "personal",
    previewFeature: null,
  },
  // Two tabs over room files: the selection guide agents read to pick a
  // harness, model and effort, and the agent definitions a harness can start.
  // The section `id` (and its `/settings/agents` route) is an internal
  // identifier on the compatibility boundary and stays put.
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    group: "personal",
    previewFeature: null,
  },
  // "Model routing" and not "Route automatically" - the section is the whole
  // subject, and "Route automatically" is the master toggle INSIDE it, so using
  // the same words for both would make the rail row read as a switch.
  {
    id: "fallback",
    label: "Model routing",
    icon: Waypoints,
    group: "personal",
    previewFeature: null,
  },
  // The section `id` stays `shell`; the page now also holds the variables
  // every agent starts with, so the label names both.
  {
    id: "shell",
    label: "Variables & shells",
    icon: TerminalSquare,
    group: "personal",
    previewFeature: null,
  },
  // Whether agents may drive the in-app browser. Not offered in navigation
  // (`RETIRED_SETTINGS_SECTION_IDS`): the switch is the Browser tab of
  // Permissions, and its route redirects there.
  {
    id: "browser-agent-access",
    label: "Browser agent access",
    icon: MousePointerClick,
    group: "personal",
    previewFeature: null,
  },
  // Where secrets and GitHub access are managed. The page itself lives on the
  // web dashboard; this entry is how Settings reaches it.
  {
    id: "secrets",
    label: "Secrets",
    icon: LockKeyhole,
    group: "personal",
    previewFeature: "environments",
  },
  // Every sandbox on the picked configuration's settings. The page itself is
  // the sandboxes plan's, mounted in the Environment page registry's
  // `sandboxes` slot.
  {
    id: "sandboxes",
    label: "Sandboxes",
    icon: Cloud,
    group: "personal",
    previewFeature: "sandboxes",
  },
  // A team's members (P2's page). Offered only while a team is picked
  // (`environmentSectionShown`).
  {
    id: "members",
    label: "Members",
    icon: Users,
    group: "personal",
    previewFeature: "environments",
  },
  // The agent definition files every host gets. Not offered in navigation
  // (`RETIRED_SETTINGS_SECTION_IDS`): they are the Agents page's Definitions
  // tab, and the route redirects there.
  {
    id: "agent-definitions",
    label: "Agent definitions",
    icon: FileText,
    group: "personal",
    previewFeature: "environments",
  },
  // The script each computer runs once to set itself up, one per OS. Not
  // offered in navigation (`RETIRED_SETTINGS_SECTION_IDS`); its route still
  // resolves.
  {
    id: "machine-setup",
    label: "Machine setup",
    icon: Wrench,
    group: "personal",
    previewFeature: "environments",
  },
  {
    id: "dev-artifact-proof",
    label: "Dev: artifact serving proof",
    icon: Activity,
    group: "app",
    previewFeature: null,
  },
  {
    id: "dev-canvas-proof",
    label: "Dev: canvas proof",
    icon: Activity,
    group: "app",
    previewFeature: null,
  },
  // The host group. Everything here is scoped by the picker that heads it.
  {
    id: "host",
    label: "Overview",
    icon: Server,
    group: "host",
    previewFeature: null,
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: GitBranch,
    group: "host",
    previewFeature: null,
  },
  // Same kind of page as Application → Diagnostics, partitioned by scope, so
  // the same word and icon. Everything left here answers differently per host,
  // which is what earns it a place under the picker.
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: Activity,
    group: "host",
    previewFeature: null,
  },
];

/**
 * Sections the installed mobile app does not offer. Two different reasons sit
 * here, and the difference is worth keeping straight:
 *
 * - **Keybindings — the shell cannot drive it.** Every chord is captured from
 *   a `keydown` on `window` (`chord-capture-core.tsx`), a binding is cleared
 *   with Backspace and committed by the next full chord, so on a touch shell
 *   the chip arms to "Press chord…" and can never resolve, and an existing
 *   binding can never be removed. A section whose every control needs a
 *   hardware keyboard is a dead end on a phone, not a sparse page.
 * - **Link mobile app — the role is backwards.** The panel DISPLAYS a QR and a
 *   one-time code for another device to read, and in the mobile app that
 *   device is the one holding the panel: the phone is the SCANNER
 *   (`link-code-sign-in.tsx` redeems a code this panel mints, and its own copy
 *   says "On your desktop, open Settings → Link mobile app"). A phone could
 *   physically show the code to a second phone, so this is a product decision
 *   about which end of the pairing each build is, not an inability.
 */
const MOBILE_APP_OMITTED_SECTION_IDS: ReadonlySet<SettingsSectionId> = new Set([
  "keybindings",
  "link-phone",
]);

/**
 * The mirror image: sections ONLY the installed mobile app offers.
 *
 * - **Delete account — the requirement is the App Store's.** Guideline
 *   5.1.1(v) obliges an app that creates accounts to offer deletion from
 *   inside the app, and this section is how Traycer's iOS build satisfies it.
 *   Desktop and the web GUI are not under that rule and already reach account
 *   management on the web, so a second, slower route there would be a worse
 *   answer to a question they can already answer. It is a scope decision, not
 *   an inability: nothing in the panel needs a phone.
 *
 * Kept a separate set from `MOBILE_APP_OMITTED_SECTION_IDS` rather than a
 * per-entry flag on the table, because the two lists answer different
 * questions and a single `availableOn` column would have to be read in both
 * directions at every call site.
 */
const MOBILE_APP_ONLY_SECTION_IDS: ReadonlySet<SettingsSectionId> = new Set([
  "delete-account",
]);

/**
 * Proof pages for developers, offered in navigation by dev builds only. They
 * stay in `SETTINGS_SECTIONS` so a production deep link still resolves and
 * reaches its 404 panel, and they have no settings-search collection, since
 * search would otherwise point production users at pages they cannot open.
 */
export const DEV_ONLY_SETTINGS_SECTION_IDS: ReadonlySet<SettingsSectionId> =
  new Set(["dev-artifact-proof", "dev-canvas-proof"]);

/**
 * Sections no build offers in navigation any more, the way dev-only ones are
 * withheld from production: they stay in `SETTINGS_SECTIONS` so a remembered
 * path or a deep link still resolves, and they have no search collection.
 * Machine setup left the Environment group with the redesign; Agent
 * definitions became the Agents page's Definitions tab and Browser agent
 * access the Browser tab of Permissions.
 */
export const RETIRED_SETTINGS_SECTION_IDS: ReadonlySet<SettingsSectionId> =
  new Set(["machine-setup", "agent-definitions", "browser-agent-access"]);

/**
 * The page that now holds a retired section, where one does: a remembered
 * section or a link that names it opens that page, as its route redirects
 * there.
 */
export const RETIRED_SECTION_REPLACEMENTS: Readonly<
  Partial<Record<SettingsSectionId, SettingsSectionId>>
> = {
  "agent-definitions": "agents",
  "browser-agent-access": "permissions",
};

/** The Environment group's heading when there is no configuration to pick. */
const AGENT_SETTINGS_GROUP_LABEL = "Agent settings";

/**
 * A group's heading. Without environments the Environment group has no
 * configuration to pick and holds this computer's agent settings alone.
 */
export function settingsGroupLabel(
  group: SettingsSectionGroup,
  environments: boolean,
): string {
  return group.id === "personal" && !environments
    ? AGENT_SETTINGS_GROUP_LABEL
    : group.label;
}

/** The heading of the group `sectionId` sits in, as the rail shows it. */
export function settingsSectionScopeLabel(
  sectionId: SettingsSectionId,
  environments: boolean,
): string {
  const groupId = SETTINGS_SECTIONS.find(
    (section) => section.id === sectionId,
  )?.group;
  const group = SETTINGS_SECTION_GROUPS.find(
    (candidate) => candidate.id === groupId,
  );
  return group === undefined ? "" : settingsGroupLabel(group, environments);
}

/** The preview feature `sectionId` needs on, or `null` for none. */
export function settingsSectionPreviewFeature(
  sectionId: SettingsSectionId,
): PreviewFeature | null {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === sectionId)
      ?.previewFeature ?? null
  );
}

/**
 * Both offered lists, resolved once at module load.
 *
 * Precomputed rather than filtered per call so each build's list keeps ONE
 * identity for the process's life - consumers memoize on it and compare it by
 * reference. (This used to be `SETTINGS_SECTIONS` itself on every non-mobile
 * build, which gave the same guarantee for free; now that both builds drop
 * something, both need a constant of their own.) The `isMobileApp()` read
 * stays inside the function below: the flag is written by the Capacitor entry
 * before the first render, which is not necessarily before this module is
 * evaluated.
 */
const OFFERED_SECTIONS = SETTINGS_SECTIONS.filter(
  (section) =>
    !RETIRED_SETTINGS_SECTION_IDS.has(section.id) &&
    (import.meta.env.DEV || !DEV_ONLY_SETTINGS_SECTION_IDS.has(section.id)),
);

const DESKTOP_SECTIONS: ReadonlyArray<SettingsSection> =
  OFFERED_SECTIONS.filter(
    (section) => !MOBILE_APP_ONLY_SECTION_IDS.has(section.id),
  );

const MOBILE_APP_SECTIONS: ReadonlyArray<SettingsSection> =
  OFFERED_SECTIONS.filter(
    (section) => !MOBILE_APP_OMITTED_SECTION_IDS.has(section.id),
  );

/**
 * The sections a build OFFERS, as opposed to the ones it can resolve.
 *
 * `SETTINGS_SECTIONS` stays whole because it is the compatibility table:
 * routes, remembered tab paths and titles all resolve an id through it, and an
 * id that no longer resolves is a broken lookup rather than a hidden row. This
 * is the list anything that PRESENTS a choice reads instead — the sidebar, the
 * command palette's settings sub-page, and the leader digits, which index
 * positionally and so must walk the same list the sidebar badges do.
 */
export function visibleSettingsSections(): ReadonlyArray<SettingsSection> {
  return isMobileApp() ? MOBILE_APP_SECTIONS : DESKTOP_SECTIONS;
}

/**
 * Whether this build offers `sectionId` at all. A surface holding a REMEMBERED
 * id (a persisted modal section, a restored tab path) asks this before showing
 * the panel for it, so a build that dropped a section cannot present a panel
 * its own navigation has no row for.
 */
export function isSettingsSectionVisible(
  sectionId: SettingsSectionId,
): boolean {
  return visibleSettingsSections().some((section) => section.id === sectionId);
}

// No `HOST_SCOPED_SECTION_IDS` / `isHostScopedSection` helper here. Whether a
// section is host-scoped is already stated by `group: "host"` in the table
// above, and the sidebar is the only thing that asks. A derived Set plus a
// predicate over it was a second source for a fact the data already carries.
