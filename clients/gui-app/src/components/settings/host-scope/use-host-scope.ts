import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostPresenceHealth } from "@traycer/protocol/host/host-status";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useLocalHostSnapshot } from "@/components/settings/panels/host-settings-panel-hooks";
import { deriveStatus } from "@/components/settings/panels/host-settings-panel-model";
import { getViewerReachabilityCheck } from "@/lib/host/viewer-reachability-store";
import { useHostBinding, useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  buildHostScopeOptions,
  findHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

/**
 * Whether the host a panel is showing is the host its client actually talks to.
 *
 * These four are the whole safety contract of this surface, and they exist
 * because three of them look identical if you only check `client !== null`:
 *
 *   - `following` — no explicit pick; the panel is scoped to the active host.
 *     Its client IS the ambient one, so reading through it is correct.
 *   - `connecting` — a non-active host is picked and its transient client is
 *     still being built. `client` is `null`. Callers must NOT fall back to the
 *     ambient client: doing so shows host A's data under host B's name.
 *   - `unreachable` — the picked host exists but this client has no route to
 *     it (registry-only row, or a directory entry with no websocket URL).
 *     `client` is `null`, permanently, until something changes.
 *   - `vanished` — the picked host left the directory entirely: deregistered,
 *     or signed out from. `host` is `null` and the caller must say so and
 *     offer a way back. It deliberately does NOT auto-reset to the active
 *     host: silently re-pointing an administration surface at a different
 *     machine is the precise failure this whole redesign exists to remove, and
 *     it is worst here — the moment a destructive dialog is open.
 *   - `ready` — the picked host resolved to a live client of its own.
 *
 * The invariant every consumer owes: **a visible host name must always match
 * the client used by every read, stream and mutation beneath it.** When that
 * cannot be proven, render loading or unavailable — never somebody else's data.
 */
export type HostScopeStatus =
  | "following"
  | "connecting"
  | "unreachable"
  | "vanished"
  | "ready";

export interface HostScope {
  /** Every host this account owns or this client can dial, merged and sorted. */
  readonly hosts: readonly HostScopeOption[];
  /** The host being administered. `null` when there are no hosts, or `vanished`. */
  readonly host: HostScopeOption | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The id that was picked but is no longer listed — only when `vanished`. */
  readonly vanishedHostId: string | null;
  /** Drop an explicit pick and follow the active host again. */
  readonly returnToActive: () => void;
  /** The app-wide active host — where new work lands and the bell reads from. */
  readonly activeHostId: string | null;
  readonly activeHost: HostScopeOption | null;
  /** True when the administered host is also the active one. */
  readonly isViewingActive: boolean;
  readonly status: HostScopeStatus;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly setHostId: (hostId: string) => void;
  /** Point this window's ambient work at the administered host. */
  readonly makeActive: (hostId: string) => void;
  readonly isLoading: boolean;
  /** Reference "now" for relative timestamps; ticks once a minute. */
  readonly nowMs: number;
}

const HEALTHY_PRESENCE: HostPresenceHealth = { status: "healthy", reason: null };

/**
 * The one host-scope hook for Settings. Every host-scoped panel reads this and
 * nothing else, which is what makes the sidebar switcher authoritative rather
 * than one more picker among five.
 */
export function useHostScope(): HostScope {
  const ambientClient = useHostClient();
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const activeHostId = useReactiveActiveHostId();
  const nowMs = useNowMs();

  const directoryQuery = useHostDirectoryList();
  const registryQuery = useRegisteredHosts();
  const localSnapshot = useLocalHostSnapshot(runnerHost);
  const localHostId = binding?.directory.getLocalEntry()?.hostId ?? null;

  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const setScopedHostId = useSettingsHostScopeStore((s) => s.setScopedHostId);

  const directory = directoryQuery.data;
  const registry = registryQuery.data;

  // The local service snapshot alone cannot distinguish "stopped" from "not
  // installed" — that needs the installed record, which only the Host panel
  // queries. Passing `undefined` for the record keeps this honest: the local
  // row reads `running` when a snapshot exists, and otherwise defers to the
  // registry rather than guessing which of the two non-running states it is.
  const localService = useMemo(
    () => deriveStatus(localSnapshot, undefined),
    [localSnapshot],
  );

  const hosts = useMemo(
    () =>
      buildHostScopeOptions({
        directory: directory ?? [],
        registry: registry?.hosts ?? [],
        presenceHealth: registry?.presenceHealth ?? HEALTHY_PRESENCE,
        localHostId,
        activeHostId,
        localService,
        hasLiveSession: hasReadyRemoteSession,
        viewerCheck: getViewerReachabilityCheck,
        nowMs,
      }),
    [directory, registry, localHostId, activeHostId, localService, nowMs],
  );

  // Resolution order matters, and the `vanished` branch is the load-bearing
  // one. An explicit pick that is no longer in the list must NOT quietly
  // resolve to the active host: that is a silent retarget of an
  // administration surface, and it is exactly how a destructive action ends
  // up aimed at a machine the user never chose. It resolves to nothing, and
  // the caller is obliged to say so.
  const resolved = useMemo((): {
    readonly host: HostScopeOption | null;
    readonly vanishedHostId: string | null;
  } => {
    if (scopedHostId !== null) {
      const picked = findHostOption(hosts, scopedHostId);
      if (picked !== null) return { host: picked, vanishedHostId: null };
      // Still loading the lists is not the same as gone. Withhold the verdict
      // until there is something to be absent FROM, or the first paint of a
      // cold Settings would accuse every host of having been deregistered.
      if (hosts.length === 0) return { host: null, vanishedHostId: null };
      return { host: null, vanishedHostId: scopedHostId };
    }
    const active = findHostOption(hosts, activeHostId);
    if (active !== null) return { host: active, vanishedHostId: null };
    // No explicit pick and no active host: administer the first machine
    // rather than rendering a pane the user cannot act on. This is a default,
    // not a fallback from a pick — nothing was overridden.
    return { host: hosts[0] ?? null, vanishedHostId: null };
  }, [hosts, scopedHostId, activeHostId]);

  const host = resolved.host;
  const isFollowing =
    resolved.vanishedHostId === null &&
    host !== null &&
    host.hostId === activeHostId;

  // Only a genuinely different host needs a transient client; the active host
  // already has the ambient one, and building a second client for it would
  // duplicate its socket for no gain.
  const overrideEntry = useMemo(
    () => (isFollowing ? null : (host?.entry ?? null)),
    [isFollowing, host],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  const status = deriveHostScopeStatus({
    isFollowing,
    host,
    vanishedHostId: resolved.vanishedHostId,
    overrideClient,
  });

  return {
    hosts,
    host,
    hostId: host?.hostId ?? null,
    hostLabel: host?.name ?? resolved.vanishedHostId ?? "No host",
    vanishedHostId: resolved.vanishedHostId,
    returnToActive: () => setScopedHostId(null),
    activeHostId,
    activeHost: findHostOption(hosts, activeHostId),
    isViewingActive: isFollowing,
    status,
    // `overrideClient` is already null for both `connecting` and `unreachable`,
    // so only the `following` branch may swap in the ambient client. Any other
    // branch handing back `ambientClient` would be the exact substitution this
    // status enum exists to make impossible.
    client: status === "following" ? ambientClient : overrideClient,
    setHostId: setScopedHostId,
    makeActive: (hostId: string) => {
      binding?.directory.selectById(hostId);
    },
    isLoading: directoryQuery.isLoading || registryQuery.isLoading,
    nowMs,
  };
}

function deriveHostScopeStatus(input: {
  readonly isFollowing: boolean;
  readonly host: HostScopeOption | null;
  readonly vanishedHostId: string | null;
  readonly overrideClient: HostClient<HostRpcRegistry> | null;
}): HostScopeStatus {
  if (input.vanishedHostId !== null) return "vanished";
  if (input.isFollowing) return "following";
  if (input.host === null) return "unreachable";
  // No route exists and none is being built — this is terminal, not pending,
  // and must not render as a spinner that never resolves.
  if (!input.host.connectable) return "unreachable";
  if (input.overrideClient === null) return "connecting";
  return "ready";
}

/** True when the scope resolved to a client the caller may read/write through. */
export function isHostScopeUsable(status: HostScopeStatus): boolean {
  return status === "following" || status === "ready";
}
