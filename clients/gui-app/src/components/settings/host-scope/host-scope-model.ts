import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostListItem,
  HostPresenceHealth,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  deriveHostHealth,
  type HostHealth,
} from "@/components/settings/host-scope/host-health";
import type { ViewerReachabilityCheckLike } from "@/components/settings/panels/my-hosts-model";

/**
 * ONE host, as every settings surface should see it.
 *
 * The app carries two host lists that do not have to agree:
 *
 *   - the **runtime directory** (`useHostDirectoryList`) — what this client
 *     can actually dial. It knows `websocketUrl`, so it alone decides whether
 *     a host can be administered at all.
 *   - the **cloud registry** (`useRegisteredHosts`) — what the ACCOUNT owns.
 *     It alone knows presence leases, platform, update state and policy.
 *
 * Every picker until now was built on exactly one of them, so each was blind
 * to a real class of host: directory-only pickers could not say whether a
 * machine was online, and a registry-only list would offer rows nothing could
 * connect to. This model is their UNION, keyed by `hostId`, with `connectable`
 * and `registered` recording which side each row came from — so a row that
 * exists in only one list renders honestly instead of being dropped or faked.
 */
export interface HostScopeOption {
  readonly hostId: string;
  /** Best available human name. Never a bare id unless nothing else exists. */
  readonly name: string;
  /** This client's own machine — the one whose service we can install/restart. */
  readonly isLocalMachine: boolean;
  /** The app-wide active host: where new work lands, what the bell reads. */
  readonly isActive: boolean;
  /** In the runtime directory with a dialable URL — i.e. administrable. */
  readonly connectable: boolean;
  /**
   * `connectable` is false ONLY because of the plan gate: the route is
   * present and live, and the server would refuse the attach
   * (`plan_restricted`). A consumer that renders this as "unreachable"
   * erases the actual remedy — the fix is an upgrade, not a retry.
   */
  readonly planRestricted: boolean;
  /** Present in the account's host registry. */
  readonly registered: boolean;
  readonly platform: string | null;
  /** Version as last reported. `null` when nothing has reported one. */
  readonly version: string | null;
  readonly health: HostHealth;
  readonly updateState: HostUpdateState | null;
  readonly busySessionCount: number;
  /** The directory entry, when there is one — needed to build a client. */
  readonly entry: HostDirectoryEntry | null;
  /** The registry row, when there is one — needed for update policy writes. */
  readonly item: HostListItem | null;
}

export interface BuildHostScopeOptionsInput {
  readonly directory: readonly HostDirectoryEntry[];
  readonly registry: readonly HostListItem[];
  readonly presenceHealth: HostPresenceHealth;
  readonly localHostId: string | null;
  readonly activeHostId: string | null;
  /** Local service truth, used only for the local machine's row. */
  readonly localService: ServiceStatusSnapshot | undefined;
  readonly hasLiveSession: (hostId: string) => boolean;
  readonly viewerCheck: (hostId: string) => ViewerReachabilityCheckLike | null;
  /**
   * The account's plan does not include remote hosts. Their relay URLs still
   * appear in the directory, but attaching is refused server-side, so the route
   * is not usable even though it looks like one.
   */
  readonly remoteHostsPlanRestricted: boolean;
  readonly nowMs: number;
}

export function buildHostScopeOptions(
  input: BuildHostScopeOptionsInput,
): readonly HostScopeOption[] {
  const entries = new Map(input.directory.map((e) => [e.hostId, e]));
  const items = new Map(input.registry.map((i) => [i.hostId, i]));
  const hostIds = [...new Set([...entries.keys(), ...items.keys()])];

  const options = hostIds.map((hostId): HostScopeOption => {
    const entry = entries.get(hostId) ?? null;
    const item = items.get(hostId) ?? null;
    const isLocalMachine = hostId === input.localHostId;
    return {
      hostId,
      name: resolveHostName(hostId, entry, item, isLocalMachine),
      isLocalMachine,
      isActive: hostId === input.activeHostId,
      connectable: isAdministrableRoute(entry, input.remoteHostsPlanRestricted),
      planRestricted: isPlanRestrictedRoute(
        entry,
        input.remoteHostsPlanRestricted,
      ),
      registered: item !== null,
      platform: item?.platform ?? null,
      version: item?.status.appVersion ?? entry?.version ?? null,
      health: deriveHostHealth({
        item,
        presenceHealth: input.presenceHealth,
        isLocalMachine,
        hasLiveSession: input.hasLiveSession(hostId),
        viewerCheck: input.viewerCheck(hostId),
        service: isLocalMachine ? input.localService : undefined,
        nowMs: input.nowMs,
      }),
      updateState: item?.status.updateState ?? null,
      busySessionCount: item?.status.busySessionCount ?? 0,
      entry,
      item,
    };
  });

  return options.sort(compareHostOptions);
}

/**
 * Can this row be administered over the host's own RPC right now?
 *
 * A directory entry with no websocket URL is a listing, not a route:
 * `buildTransientHostClient` returns null for it, so offering it as an
 * administrable target would produce a picker row that can never load.
 *
 * `status` is half of that question, not a detail. The repository's canonical
 * dialability rule lives in `dialableHostEndpoint` / `hostTransportKey`, and
 * BOTH refuse an entry that is not `available` even when it still carries a
 * URL — a stale address left behind by a host that went away.
 * `buildTransientHostClient` does not re-check it, so a URL-only test handed
 * back a live-looking client whose every call hangs: the scope read `ready`,
 * panels mounted, and the Add-host dialog announced a machine as connected and
 * ready to run agents. Asking the same question the transport asks is what
 * keeps this model from disagreeing with the layer that actually dials.
 *
 * The plan gate is the same kind of claim. A remote host on a plan without
 * remote hosts advertises a relay URL the server refuses to attach
 * (`plan_restricted`); the header and workspace pickers already disable those
 * rows. Registry-backed administration is account-level and unaffected, so it
 * keeps rendering — the entitlement costs the RPC route, not the whole host.
 */
function isAdministrableRoute(
  entry: HostDirectoryEntry | null,
  remoteHostsPlanRestricted: boolean,
): boolean {
  if (entry === null || entry.websocketUrl === null) return false;
  if (entry.status !== "available") return false;
  return !(remoteHostsPlanRestricted && entry.kind === "remote");
}

/**
 * The one case where `connectable: false` is a BILLING fact rather than a
 * connectivity one: the route is present and live, and only the plan gate
 * refuses it. Recorded separately because the boolean alone erased the
 * distinction — the deleted My Hosts notice said "requires a paid plan —
 * Upgrade", and rendering these rows as generically "unreachable" replaced
 * that remedy with a retry that can never work.
 */
function isPlanRestrictedRoute(
  entry: HostDirectoryEntry | null,
  remoteHostsPlanRestricted: boolean,
): boolean {
  if (entry === null || entry.websocketUrl === null) return false;
  if (entry.status !== "available") return false;
  return remoteHostsPlanRestricted && entry.kind === "remote";
}

/**
 * A name a person recognizes, in descending order of how deliberate it is:
 * the registry display name (which is what "Edit name" writes), then the
 * directory label, then the raw id as a last resort.
 *
 * THIS MACHINE is the exception, and it has to be. Renaming the local host
 * writes the local name file and reloads the desktop snapshot immediately, so
 * its directory label is correct the moment the rename returns — while the
 * registry's `displayName` only catches up after a cloud check-in and the next
 * ~15s registry poll. Preferring the registry there meant the summary card
 * showed the new name while the sidebar picker, reading this, kept showing the
 * old one for tens of seconds after a rename the user had just watched succeed.
 *
 * This is safe while the local host is DOWN, too: the directory then carries
 * `bootingLocalEntry`, whose label is copied from the registry twin, so the
 * local branch resolves to the registry name anyway rather than to nothing.
 */
function resolveHostName(
  hostId: string,
  entry: HostDirectoryEntry | null,
  item: HostListItem | null,
  isLocalMachine: boolean,
): string {
  const directoryLabel =
    entry !== null && entry.label.length > 0 ? entry.label : null;
  if (isLocalMachine && directoryLabel !== null) return directoryLabel;
  const registryName = item?.displayName ?? null;
  if (registryName !== null && registryName.length > 0) return registryName;
  if (directoryLabel !== null) return directoryLabel;
  return hostId;
}

/**
 * Stable ordering: this machine, then the active host, then everything else
 * alphabetically. Deliberately NOT sorted by health — a list that reorders
 * itself when a host blinks would move a row out from under the pointer mid-
 * click, and the registry polls every ~15s.
 */
function compareHostOptions(a: HostScopeOption, b: HostScopeOption): number {
  if (a.isLocalMachine !== b.isLocalMachine) return a.isLocalMachine ? -1 : 1;
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export interface ScopeResolution {
  readonly host: HostScopeOption | null;
  /** The id that was picked but is no longer listed. Only ever a real verdict. */
  readonly vanishedHostId: string | null;
}

/**
 * Turn an explicit pick (or its absence) into the host this surface administers.
 *
 * Resolution order matters, and the `vanished` branch is the load-bearing one.
 * An explicit pick that is no longer in the list must NOT quietly resolve to
 * the active host: that is a silent retarget of an administration surface, and
 * it is exactly how a destructive action ends up aimed at a machine the user
 * never chose. It resolves to nothing, and the caller is obliged to say so.
 *
 * Two conditions have to be true before that verdict may be spoken, and they
 * are different questions:
 *
 *   - both lists have ANSWERED (`listsResolved`) — still loading is not gone;
 *   - neither answered with an ERROR (`listsFailed`) — a failed source cannot
 *     testify that a host was removed. A directory failure hides every
 *     directory-only host and a registry failure hides every registry-only one,
 *     so the pinned host is missing from the union for a reason that has
 *     nothing to do with it.
 *
 * Lives here rather than inside `useHostScope` for the same reason
 * `hostListReadiness` does: every panel suite mocks that hook wholesale, so a
 * rule written inside it is a rule no test can reach.
 */
export function resolveScopedHost(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly scopedHostId: string | null;
  readonly activeHostId: string | null;
  readonly listsResolved: boolean;
  readonly listsFailed: boolean;
}): ScopeResolution {
  if (input.scopedHostId !== null) {
    const picked = findHostOption(input.hosts, input.scopedHostId);
    if (picked !== null) return { host: picked, vanishedHostId: null };
    // Keying on `hosts.length` got this wrong in both directions: a
    // registry-only host was declared vanished the instant the directory
    // resolved first, and deregistering your ONLY host emptied the union so the
    // verdict could never fire at all.
    if (!input.listsResolved) return { host: null, vanishedHostId: null };
    // Withholding the verdict here resolves to the list-error notice instead,
    // which offers a retry and claims nothing about the host.
    if (input.listsFailed) return { host: null, vanishedHostId: null };
    return { host: null, vanishedHostId: input.scopedHostId };
  }
  const active = findHostOption(input.hosts, input.activeHostId);
  if (active !== null) return { host: active, vanishedHostId: null };
  // No explicit pick and no active host: administer the first machine rather
  // than rendering a pane the user cannot act on. This is a default, not a
  // fallback from a pick — nothing was overridden.
  return { host: input.hosts[0] ?? null, vanishedHostId: null };
}

/**
 * The one rule for which directory entry a transient client may be built
 * from. `buildTransientHostClient` checks only that a `websocketUrl` exists —
 * not `status`, not the plan gate — so any caller that hands it an entry from
 * a non-`connectable` row gets back a live-looking client for a route the
 * transport refuses. Panels read `scope.client` before their gate renders
 * (Notifications does), so such a client does not sit unused: it fires real
 * queries. Withholding the ENTRY here means the client never exists.
 *
 * `isFollowing` is not a refusal — the active host already has the ambient
 * client, and building a second one would duplicate its socket.
 *
 * Lives here rather than inline in `useHostScope` for the same reason every
 * other rule in this file does: panel suites mock the hook wholesale, so a
 * rule inside it is a rule no test can reach.
 */
export function transientClientEntry(
  host: HostScopeOption | null,
  isFollowing: boolean,
): HostDirectoryEntry | null {
  if (isFollowing || host === null || !host.connectable) return null;
  return host.entry;
}

export function findHostOption(
  options: readonly HostScopeOption[],
  hostId: string | null,
): HostScopeOption | null {
  if (hostId === null) return null;
  return options.find((option) => option.hostId === hostId) ?? null;
}

/**
 * A short platform word for the identity line ("macOS", "Linux", "Windows").
 * The registry reports raw Node platform triples like `darwin-arm64`, which
 * name the build target rather than the machine and read as debug output in
 * an identity line. The architecture is kept as a separate detail rather than
 * discarded — it matters when picking an install — but it stops leading.
 */
export function formatPlatform(platform: string | null): string | null {
  if (platform === null || platform.length === 0) return null;
  const [os] = platform.split("-");
  switch (os) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platform;
  }
}

/** The architecture half of a `darwin-arm64` style triple, when present. */
export function formatArchitecture(platform: string | null): string | null {
  if (platform === null) return null;
  const parts = platform.split("-");
  if (parts.length < 2) return null;
  const arch = parts.slice(1).join("-");
  return arch.length === 0 ? null : arch;
}

/**
 * Host versions arrive in two flavours: a real semver (`1.4.2`) and a staging
 * build id (`vstaging.1785936318070.4e951281b`). The build id was being
 * rendered as the primary version string, which is unreadable and says nothing
 * a person can act on. Real versions get a `v` prefix; anything else is
 * reported as a build so the identity line never claims a version it doesn't
 * have.
 */
export function formatHostVersion(version: string | null): string | null {
  if (version === null || version.length === 0) return null;
  if (/^\d+\.\d+\.\d+/.test(version)) return `v${version}`;
  return "Preview build";
}
