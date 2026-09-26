import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// No host-GATED element carries an anchor (SETTINGS.md § Search); a tab trigger
// is not gated. The page's four tab triggers render for every host in every
// state - connecting, restarting, unreachable, stopped - because the header and
// the tab bar sit outside anything that withholds a body, and each tab body
// decides for itself what it can show. So each tab anchors on its trigger (on a
// phone, on the section Select, which carries the active tab's anchor), and a
// search that lands there opens the tab. The page's own vocabulary is split
// across the four tabs by the core flows' Search table; the words about the
// header (the host itself, its name, its connection, Restart) stay on the page,
// since the header is on every tab.
//
// Everything INSIDE a tab body still folds into the page: its cards come and go
// with the host's state, so none of them is a stable destination. In the two
// page states that draw no header and no tabs (a host removed from the account
// while you look at it, an account with no host), a tab result opens the page
// and its reveal lapses at the deadline.
export const HOST_OVERVIEW = defineSettingsSection("host", {
  page: {
    label: "Overview",
    description: "The selected host's status, version, and installation.",
    // The header's words: it is drawn over every tab, so a result for any of
    // them opens the page on whichever tab it is already showing.
    keywords: [
      "host",
      "status",
      "restart",
      "rename",
      "machine",
      "server",
      "connection",
    ],
  },
  updatesTab: {
    kind: "group",
    search: { anchor: "host-overview-tab-updates" },
    label: "Updates",
    description:
      "The running version, checking for updates, auto-update, and installing a specific version.",
    breadcrumb: "Overview",
    availableWhen: alwaysAvailable,
    keywords: [
      "version",
      "update",
      "upgrade",
      "check for updates",
      "auto-update",
      "release candidate",
      "pre-release",
      "downgrade",
      "install version",
      "pick version",
    ],
  },
  portsTab: {
    kind: "group",
    search: { anchor: "host-overview-tab-ports" },
    label: "Ports",
    description:
      "The ports forwarded through this host, and the ones other machines hold here.",
    breadcrumb: "Overview",
    availableWhen: alwaysAvailable,
    keywords: [
      "port forward",
      "port forwards",
      "forwarded port",
      "localhost",
      "tunnel",
      "cut",
    ],
  },
  dataTab: {
    kind: "group",
    search: { anchor: "host-overview-tab-data" },
    label: "Data",
    description:
      "Importing work, migration, and the history this host keeps on its disk.",
    breadcrumb: "Overview",
    availableWhen: alwaysAvailable,
    keywords: [
      "import your work",
      "import",
      "data & migration",
      "migration",
      "migrate",
      "transfer",
      "cloud",
      "version history",
      "artifact history",
      "retention",
      "file edit snapshots",
      "snapshots",
      "undo",
      "disk space",
      "cache",
    ],
  },
  installationTab: {
    kind: "group",
    search: { anchor: "host-overview-tab-installation" },
    label: "Installation",
    description: "How this host is installed and started, and removing it.",
    breadcrumb: "Overview",
    availableWhen: alwaysAvailable,
    keywords: [
      "about this host",
      "host id",
      "installation",
      "install",
      "path",
      "binary",
      "service",
      "register",
      "deregister",
      "danger zone",
      "remove",
      "uninstall",
      "remove traycer",
      "delete",
      "remove from account",
      "unlink",
    ],
  },
  versionHistory: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Version history",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  captureVersions: {
    kind: "row",
    group: "versionHistory",
    search: { contributesTo: "page" },
    label: "Capture versions",
    description: "Save restorable observations of artifact edits on this host.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  retention: {
    kind: "row",
    group: "versionHistory",
    search: { contributesTo: "page" },
    label: "Retention",
    description: "History is pruned when any per-artifact limit is reached.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  clearVersionHistory: {
    kind: "row",
    group: "versionHistory",
    search: { contributesTo: "page" },
    label: "Clear version history",
    description:
      "Remove every saved artifact version from this host. Undo for agent turns is unaffected.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  dataAndMigration: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Import & migration",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  importYourWork: {
    kind: "row",
    group: "dataAndMigration",
    search: { contributesTo: "page" },
    label: "Import your work",
    // Switches to live progress while an import runs, so it is a status.
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  dataMigration: {
    kind: "row",
    group: "dataAndMigration",
    search: { contributesTo: "page" },
    label: "Data migration",
    // Switches to live progress while a migration runs, so it is a status.
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // The Installation tab's groups, top to bottom (the Danger zone is below).
  // About this host is read from the account's record, not the host.
  aboutThisHost: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "About this host",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  installRecord: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Install record",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  osService: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "OS service",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  commandLineTools: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Command-line tools",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Ports' two groups. Each is drawn only while it has a row, so like every
  // card inside a tab body they fold into the page; the tab trigger is the
  // destination.
  portForwardsOwned: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Forwards on this host",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  portForwardsHeld: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Ports other machines hold here",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  dangerZone: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Danger zone",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  fileEditSnapshotsGroup: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "File edit snapshots",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  fileEditSnapshots: {
    kind: "row",
    group: "fileEditSnapshotsGroup",
    search: { contributesTo: "page" },
    label: "File edit snapshots",
    // Names the host it is about, so it is a status.
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  removeFromAccount: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Remove from account",
    // Names the host it is about, so it is a status.
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  removeTraycer: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Remove Traycer from this computer",
    description:
      "Stops the background host and services and removes the installed components. Your agents and history are preserved, and the host won't reinstall itself.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  removalIncomplete: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Traycer removal incomplete",
    description:
      "The background service is still registered. Traycer has not been fully removed; try again before quitting the app.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  removalUnverified: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Traycer removal unverified",
    description:
      "The removal commands finished, but Traycer could not verify whether the background service remains registered. Run traycer host service status in a terminal and resolve any remaining service before quitting the app.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  removed: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Traycer removed",
    description:
      "Background components were removed. Your agents, history and credentials are preserved on this computer. To finish, quit Traycer and drag it from Applications to the Trash.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});

/**
 * The page's tabs, in order. The page opens on the first. The open intent's
 * `tab` names one of these (or a retired name, below); any other name is
 * ignored.
 */
export const HOST_OVERVIEW_TABS = [
  "installation",
  "updates",
  "data",
  "ports",
] as const;

export type HostOverviewTab = (typeof HOST_OVERVIEW_TABS)[number];

/** The tab the page opens on. */
export const DEFAULT_HOST_OVERVIEW_TAB: HostOverviewTab = HOST_OVERVIEW_TABS[0];

export function isHostOverviewTab(
  value: string | null,
): value is HostOverviewTab {
  return HOST_OVERVIEW_TABS.some((tab) => tab === value);
}

/**
 * Tab names the page no longer has, and the tab that now answers each. Status
 * was folded away: its update card, the account's wait and the offline notice
 * sit above the tab bar, and its version card leads Updates. A link that
 * still names it asked for the version and the update, so it lands on Updates
 * rather than being ignored.
 */
const RETIRED_HOST_OVERVIEW_TABS: ReadonlyMap<string, HostOverviewTab> =
  new Map([["status", "updates"]]);

/**
 * The tab an open intent's `tab` selects: one of the page's tabs, a retired
 * name's replacement, or `null` for any other name, which moves nothing.
 */
export function hostOverviewTabForIntent(
  value: string | null,
): HostOverviewTab | null {
  if (value === null) return null;
  if (isHostOverviewTab(value)) return value;
  return RETIRED_HOST_OVERVIEW_TABS.get(value) ?? null;
}

/** The tab-trigger group each tab anchors on. */
export const HOST_OVERVIEW_TAB_GROUPS = {
  installation: HOST_OVERVIEW.definitions.installationTab,
  updates: HOST_OVERVIEW.definitions.updatesTab,
  data: HOST_OVERVIEW.definitions.dataTab,
  ports: HOST_OVERVIEW.definitions.portsTab,
} as const;

/**
 * The tab a settings-search landing opens: a tab trigger's anchor names its
 * tab. `null` for any other anchor, and for a page result, which opens the
 * page on whichever tab it is already showing.
 */
export function hostOverviewTabForAnchor(
  anchor: string | null,
): HostOverviewTab | null {
  if (anchor === null) return null;
  return (
    HOST_OVERVIEW_TABS.find(
      (tab) => HOST_OVERVIEW_TAB_GROUPS[tab].anchor === anchor,
    ) ?? null
  );
}
