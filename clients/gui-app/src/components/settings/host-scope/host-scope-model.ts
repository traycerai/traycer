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

/** The app carries two host lists that do not have to agree: - the runtime directory (`useHostDirectoryList`) -
 * what this client can actually dial. */
export interface HostScopeOption {
  readonly hostId: string;
  /** Best available human name. Never a bare id unless nothing else exists. */
  readonly name: string;
  readonly isLocalMachine: boolean;
  readonly isActive: boolean;
  readonly connectable: boolean;
  /** `connectable` is false only because of the plan gate: the route is present and live, and the server would
   * refuse the attach (`plan_restricted`). */
  readonly planRestricted: boolean;
  /** A per-host fact, and it lives here beside `connectable` and `health` for the same reason they do: every
   * picker must answer "what is going on with this machine" identically. */
  readonly settingUp: boolean;
  readonly registered: boolean;
  readonly platform: string | null;
  readonly version: string | null;
  readonly health: HostHealth;
  readonly updateState: HostUpdateState | null;
  readonly entry: HostDirectoryEntry | null;
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
  /** Looked up per host below rather than taken as an already-resolved value, because the lookup is the part that
   * has been got wrong before. */
  readonly leases: readonly HostLeaseSnapshot[];
  /** Threaded rather than inferred from `leases.length === 0`, which cannot tell "not attached yet" from
   * "attached, and this account genuinely has no hosts" - and the two demand opposite renderings. */
  readonly authorityAttached: boolean;
  /** The local host controller's mutation lane is busy (install, start, restart, update). */
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
    const lease = leases.get(hostId) ?? null;
    const leasePlanRestricted = isLeasePlanRestricted(lease);
    const isLocalMachine = hostId === input.localHostId;
    return {
      hostId,
      name: resolveHostName(hostId, entry, item),
      isLocalMachine,
      isActive: hostId === input.activeHostId,
      connectable:
        !leasePlanRestricted &&
        isAdministrableRoute(entry, input.hasLiveSession(hostId)),
      planRestricted: leasePlanRestricted || isPlanRestrictedRoute(entry),
      settingUp: isLocalMachine && input.localHostSettingUp,
      registered: item !== null,
      platform: item?.platform ?? null,
      version: item?.status.appVersion ?? entry?.version ?? null,
      health: deriveHostHealth({
        item,
        isLocalMachine,
        hasLiveSession: input.hasLiveSession(hostId),
        service: isLocalMachine ? input.localService : undefined,
        lease,
        authorityAttached: input.authorityAttached,
        planAllowsRemote: true,
        nowMs: input.nowMs,
      }),
      updateState: item?.status.updateState ?? null,
      entry,
      item,
    };
  });

  return options.sort(compareHostOptions);
}

function isLeasePlanRestricted(lease: HostLeaseSnapshot | null): boolean {
  return lease?.status === "dead" && lease.dead.reason === "plan-restricted";
}

/** It calls this rather than restating it, for exactly the reason the paragraph above gives: a hand-copied
 * dialability predicate is only right until the transport learns something the copy cannot be told. */
export function isAdministrableRoute(
  entry: HostDirectoryEntry | null,
  hasLiveSession: boolean,
): boolean {
  return (
    entry !== null && dialableHostEndpointFor(entry, hasLiveSession) !== null
  );
}

/** Preserve an authn-reported denial reason without deriving one from plan. */
function isPlanRestrictedRoute(entry: HostDirectoryEntry | null): boolean {
  return entry !== null && hostUnavailability(entry) === "plan-restricted";
}

/** That existed because renaming wrote a local file the registry only learned about at register/adopt time. */
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

/** Deliberately not sorted by health - a list that reorders itself when a host blinks would move a row out from
 * under the pointer mid- click, and the registry keeps polling underneath it. */
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

/** An explicit pick that is no longer in the list must not quietly resolve to the active host. */
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
    // Keying on `hosts.length` got this wrong in both directions.
    if (!input.listsResolved) return { host: null, vanishedHostId: null };
    // Withholding the verdict here resolves to the list-error notice instead,
    // which offers a retry and claims nothing about the host.
    if (input.listsFailed) return { host: null, vanishedHostId: null };
    return { host: null, vanishedHostId: input.scopedHostId };
  }
  const active = findHostOption(input.hosts, input.activeHostId);
  if (active !== null) return { host: active, vanishedHostId: null };
  // No explicit pick and no active host: administer the first machine rather than rendering a pane the user
  // cannot act on. This is a default, not a fallback from a pick - nothing was overridden.
  return { host: input.hosts[0] ?? null, vanishedHostId: null };
}

/** Withholding a non-`connectable` entry here keeps those panels from mounting a client for a route the scope
 * already knows cannot be administered. */
export function transientClientEntry(
  host: HostScopeOption | null,
  isFollowing: boolean,
): HostDirectoryEntry | null {
  if (isFollowing || host === null || !host.connectable) return null;
  return host.entry;
}

/** Why a config surface is reading this computer's disk instead of a host RPC. */
export type LocalConfigFallbackReason = "host-stopped" | "host-outdated";

/** A remote host that cannot answer has no local truth to fall back to and must say so instead. */
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

/** The registry reports raw Node platform triples like `darwin-arm64`, which name the build target rather than
 * the machine and read as debug output in an identity line. */
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

export function formatArchitecture(platform: string | null): string | null {
  if (platform === null) return null;
  const parts = platform.split("-");
  if (parts.length < 2) return null;
  const arch = parts.slice(1).join("-");
  return arch.length === 0 ? null : arch;
}

/** Real versions get a `v` prefix; anything else is reported as a build so the identity line never claims a
 * version it doesn't have. */
export function formatHostVersion(version: string | null): string | null {
  if (version === null || version.length === 0) return null;
  if (/^\d+\.\d+\.\d+/.test(version)) return `v${version}`;
  return "Preview build";
}

/** Deliberately a real `HostScopeOption` rather than a special case in the picker: the row that says "this is
 * the machine, and it cannot be reached right now" already exists and is drawn identically everywhere. */
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
    // A host the merged list has never heard of is not a machine we are installing: the mutation lane only ever
    // describes this machine, and this stand-in is by definition some other one.
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
