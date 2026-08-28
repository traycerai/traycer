import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostListItem,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
import {
  deriveHostHealth,
  type HostHealth,
} from "@/components/settings/host-scope/host-health";

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
  /**
   * This machine's own host is being installed or started right now (M5).
   *
   * A per-host fact, and it lives here beside `connectable` and `health` for
   * the same reason they do: every picker must answer "what is going on with
   * this machine" identically. It was briefly derived inside the row component
   * instead, which put a `useRunnerHost` read BELOW the boundary every picker
   * suite mocks — the pickers kept working in production and every one of
   * those suites threw, which is the shape of a fact living at the wrong
   * layer.
   *
   * Always false for a host that is not this machine: the mutation lane
   * belongs to the local host controller and says nothing about anyone else's.
   */
  readonly settingUp: boolean;
  /** Present in the account's host registry. */
  readonly registered: boolean;
  readonly platform: string | null;
  /** Version as last reported. `null` when nothing has reported one. */
  readonly version: string | null;
  readonly health: HostHealth;
  readonly updateState: HostUpdateState | null;
  /** The directory entry, when there is one — needed to build a client. */
  readonly entry: HostDirectoryEntry | null;
  /** The registry row, when there is one — needed for update policy writes. */
  readonly item: HostListItem | null;
}

export interface BuildHostScopeOptionsInput {
  readonly directory: readonly HostDirectoryEntry[];
  readonly registry: readonly HostListItem[];
  readonly localHostId: string | null;
  readonly activeHostId: string | null;
  /** Local service truth, used only for the local machine's row. */
  readonly localService: ServiceStatusSnapshot | undefined;
  readonly hasLiveSession: (hostId: string) => boolean;
  /**
   * Every lease the selection authority has published, as the store holds
   * them. Looked up PER HOST below rather than taken as an already-resolved
   * value, because the lookup is the part that has been got wrong before:
   * sealed probe P12 degraded `useHostLease`'s `find(hostId)` to `leases[0]`
   * and survived, since every suite seeded exactly one lease and a wrong-host
   * answer was indistinguishable from a right one. Anything asserting against
   * this field owes a two-host arrangement.
   */
  readonly leases: readonly HostLeaseSnapshot[];
  /**
   * Whether the authority has attached at all. Threaded rather than inferred
   * from `leases.length === 0`, which cannot tell "not attached yet" from
   * "attached, and this account genuinely has no hosts" — and the two demand
   * opposite renderings.
   */
  readonly authorityAttached: boolean;
  /**
   * The account's plan does not include remote hosts. Their relay URLs still
   * appear in the directory, but attaching is refused server-side, so the route
   * is not usable even though it looks like one.
   */
  readonly remoteHostsPlanRestricted: boolean;
  /**
   * The local host controller's mutation lane is busy (install, start,
   * restart, update). Actor-agnostic by construction — the lane is the
   * controller's own, so this is true whether the desktop's launch reconciler,
   * the selection authority's ensure, or a user's Retry asked for it.
   */
  readonly localHostSettingUp: boolean;
  readonly nowMs: number;
}

export function buildHostScopeOptions(
  input: BuildHostScopeOptionsInput,
): readonly HostScopeOption[] {
  const entries = new Map(input.directory.map((e) => [e.hostId, e]));
  const items = new Map(input.registry.map((i) => [i.hostId, i]));
  const leases = new Map(input.leases.map((l) => [l.hostId, l]));
  const hostIds = [...new Set([...entries.keys(), ...items.keys()])];

  const options = hostIds.map((hostId): HostScopeOption => {
    const entry = entries.get(hostId) ?? null;
    const item = items.get(hostId) ?? null;
    const isLocalMachine = hostId === input.localHostId;
    return {
      hostId,
      name: resolveHostName(hostId, entry, item),
      isLocalMachine,
      isActive: hostId === input.activeHostId,
      connectable: isAdministrableRoute(
        entry,
        input.remoteHostsPlanRestricted,
        input.hasLiveSession(hostId),
      ),
      planRestricted: isPlanRestrictedRoute(
        entry,
        input.remoteHostsPlanRestricted,
        input.hasLiveSession(hostId),
      ),
      settingUp: isLocalMachine && input.localHostSettingUp,
      registered: item !== null,
      platform: item?.platform ?? null,
      version: item?.status.appVersion ?? entry?.version ?? null,
      health: deriveHostHealth({
        item,
        isLocalMachine,
        hasLiveSession: input.hasLiveSession(hostId),
        service: isLocalMachine ? input.localService : undefined,
        lease: leases.get(hostId) ?? null,
        authorityAttached: input.authorityAttached,
        // The registry row carries pure liveness; the account's entitlement is
        // this input, the same one the route gates below read. Passing it here
        // is what keeps the health word and the route verdict from disagreeing
        // about the same host.
        planAllowsRemote: !input.remoteHostsPlanRestricted,
        nowMs: input.nowMs,
      }),
      updateState: item?.status.updateState ?? null,
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
 * Dialability is half of that question, not a detail — so this now CALLS the
 * canonical rule (`dialableHostEndpointFor`, with the caller-subscribed
 * ready-session answer — the ambient form's cache read is a frozen answer in
 * a memoized model) instead of restating it. It used to
 * restate it as `status === "available"`, which was the same answer only for as
 * long as the two definitions happened to agree; they stopped agreeing when the
 * transport was taught that a failed liveness read still dials, and a
 * hand-copied predicate cannot be told that.
 *
 * The URL check matters on its own: `buildTransientHostClient` does not
 * re-check it, so a URL-only test handed back a live-looking client whose every
 * call hangs — the scope read `ready`, panels mounted, and the Add-host dialog
 * announced a machine as connected and ready to run agents.
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
  hasLiveSession: boolean,
): boolean {
  if (entry === null || dialableHostEndpointFor(entry, hasLiveSession) === null)
    return false;
  // A READY session also outranks the CLIENT-side plan gate, matching the
  // transport's own mid-downgrade rule ("the existing session survives, the
  // next dial refuses"): the RPC route works over the surviving session, and
  // unmounting the panels here while every other layer keeps routing over it
  // would report a working host as unreachable. With no session the gate
  // refuses exactly as before.
  return !(
    remoteHostsPlanRestricted &&
    entry.kind === "remote" &&
    !hasLiveSession
  );
}

/**
 * The one case where `connectable: false` is a BILLING fact rather than a
 * connectivity one: only the plan gate refuses this route. Recorded separately
 * because the boolean alone erased the distinction — the deleted My Hosts
 * notice said "requires a paid plan — Upgrade", and rendering these rows as
 * generically "unreachable" replaced that remedy with a retry that can never
 * work.
 *
 * There are now TWO ways to learn it, and requiring only the first is what
 * lost the reason:
 *
 *   - the CLIENT's own plan gate (`remoteHostsPlanRestricted`) — the route is
 *     live and the server would refuse the attach;
 *   - the ENTRY's stamped plan (`planAllowsRemote: false` ⇒ `plan-restricted`)
 *     — the host is alive or unreadable, but this account has no remote route.
 *
 * The old body demanded a dialable entry, which the second case can never
 * satisfy: a `local-only` host is exactly the one the mapper marks
 * not-dialable. So a free-tier user's own host came back non-connectable AND
 * non-plan-restricted, and every surface downstream fell through to its
 * generic connection-failure copy — the upgrade path invisible precisely to
 * the person who needed it.
 */
function isPlanRestrictedRoute(
  entry: HostDirectoryEntry | null,
  remoteHostsPlanRestricted: boolean,
  hasLiveSession: boolean,
): boolean {
  if (entry === null) return false;
  if (hostUnavailability(entry) === "plan-restricted") return true;
  // The CLIENT-side gate only applies to a route that otherwise exists, so it
  // asks the transport's own question rather than a second copy of it.
  if (dialableHostEndpointFor(entry, hasLiveSession) === null) return false;
  return remoteHostsPlanRestricted && entry.kind === "remote";
}

/**
 * A name a person recognizes, in descending order of how deliberate it is:
 * the registry display name, then the directory label, then the raw id as a
 * last resort.
 *
 * This is the UNREACHABLE-host half of the naming rule. The host itself is the
 * master copy — `host.identity.get` answers `effectiveName`, and a surface with
 * a live route to the host reads that (see the Overview panel). What makes the
 * two halves agree is a settled host-side invariant rather than a coincidence:
 * `effectiveName` (`customName ?? hostLabel ?? systemName`, folded in ONE place)
 * is the value the presence heartbeat publishes, which is the value authn writes
 * to the registry's `displayName`. So a host named over RPC and the same host
 * named from this list are the same string, and this function is simply what is
 * left when there is no route to ask.
 *
 * The local machine used to be special-cased here, preferring its directory
 * label. That existed because renaming wrote a local file the registry only
 * learned about at register/adopt time — it never learned about a rename at all,
 * so the registry name went stale for good and the fresher directory label was
 * the only honest answer. The comment that used to sit here claimed the registry
 * `displayName` "is what Edit name writes"; that path never existed. Now that the
 * heartbeat carries the name, the registry is kept fresh for every host, the two
 * sources agree, and the exception would only reintroduce a way for them not to.
 */
function resolveHostName(
  hostId: string,
  entry: HostDirectoryEntry | null,
  item: HostListItem | null,
): string {
  const registryName = item?.displayName ?? null;
  if (registryName !== null && registryName.length > 0) return registryName;
  if (entry !== null && entry.label.length > 0) return entry.label;
  return hostId;
}

/**
 * Stable ordering: this machine, then the active host, then everything else
 * alphabetically. Deliberately NOT sorted by health — a list that reorders
 * itself when a host blinks would move a row out from under the pointer mid-
 * click, and the registry keeps polling underneath it.
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

/** Why a config surface is reading this computer's disk instead of a host RPC. */
export type LocalConfigFallbackReason = "host-stopped" | "host-outdated";

/**
 * Whether a config surface may honestly read the on-disk store through the
 * local CLI bridge instead of over the host's own RPC — and if so, why.
 *
 * One condition is non-negotiable: the row must be THIS machine
 * (`isLocalMachine`, an id identity — see `buildHostScopeOptions`). The store
 * the bridge reads is machine-OS-user-global, so for a local row it describes
 * exactly the host being named; for any remote row it would be the substitution
 * the whole scope model exists to prevent. A remote host that cannot answer has
 * no local truth to fall back to and must say so instead.
 *
 * Given that, two states make the RPC path unusable, and both must fall back or
 * a working page would go dark:
 *
 *   - **`host-stopped`** — no route to the process exists (`connectable`, the
 *     same dialability rule `deriveHostScopeStatus` turns into `unreachable`).
 *   - **`host-outdated`** — the process answered a handshake that did not carry
 *     the config methods. This one matters most during a fleet update: the app
 *     updates before the host it manages, and without this branch shell and
 *     diagnostics editing would disappear for exactly that window even though
 *     the on-disk store is right here and the host reads it on start.
 *
 * `methodsSupported` is deliberately the TRI-STATE answer.  `null` means no
 * handshake has completed yet — and the panel's own first RPC is what produces
 * one — so treating it as absent would abandon the RPC path before it was ever
 * tried, permanently, for a host that supports everything.
 */
export function localConfigFallbackReason(
  host: HostScopeOption | null,
  methodsSupported: boolean | null,
): LocalConfigFallbackReason | null {
  if (host === null || !host.isLocalMachine) return null;
  if (!host.connectable) return "host-stopped";
  if (methodsSupported === false) return "host-outdated";
  return null;
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

/**
 * The stand-in row for a host a surface is PINNED to but the merged list has
 * never heard of — a terminal agent's own host, in a window that has since lost
 * sight of it.
 *
 * Deliberately a real `HostScopeOption` rather than a special case in the
 * picker: the row that says "this is the machine, and it cannot be reached
 * right now" already exists and is drawn identically everywhere. A one-off
 * shape for this case is how the fixed surface would drift back into having its
 * own vocabulary for "offline".
 */
export function unavailableHostOption(
  hostId: string,
  name: string,
): HostScopeOption {
  return {
    hostId,
    name,
    isLocalMachine: false,
    isActive: false,
    connectable: false,
    planRestricted: false,
    // A host the merged list has never heard of is not a machine we are
    // installing: the mutation lane only ever describes THIS machine, and this
    // stand-in is by definition some other one.
    settingUp: false,
    registered: false,
    platform: null,
    version: null,
    health: {
      state: "offline",
      label: "Offline",
      detail: null,
      tone: "idle",
      live: false,
    },
    updateState: null,
    entry: null,
    item: null,
  };
}
