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
      name: resolveHostName(hostId, entry, item),
      isLocalMachine,
      isActive: hostId === input.activeHostId,
      // A directory entry with no websocket URL is a listing, not a route:
      // `buildTransientHostClient` returns null for it, so offering it as an
      // administrable target would produce a picker row that can never load.
      connectable: entry !== null && entry.websocketUrl !== null,
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
 * A name a person recognizes, in descending order of how deliberate it is:
 * the registry display name (which is what "Edit name" writes), then the
 * directory label, then the raw id as a last resort.
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
 * click, and the registry polls every ~15s.
 */
function compareHostOptions(a: HostScopeOption, b: HostScopeOption): number {
  if (a.isLocalMachine !== b.isLocalMachine) return a.isLocalMachine ? -1 : 1;
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  return a.name.localeCompare(b.name);
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
