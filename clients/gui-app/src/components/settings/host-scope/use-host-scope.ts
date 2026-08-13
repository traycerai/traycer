import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import {
  deriveHostScopeStatus,
  type HostScopeStatus,
} from "@/components/settings/host-scope/host-scope-status";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  findHostOption,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

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
  /**
   * A host list came back as an ERROR, so an empty `hosts` means "we could not
   * find out", not "you own no machines". The difference is the whole message:
   * one is recoverable by retrying, the other by installing a host.
   */
  readonly listsFailed: boolean;
  /** Re-request both host lists after a failure. */
  readonly retryLists: () => void;
  /** Reference "now" for relative timestamps; ticks once a minute. */
  readonly nowMs: number;
}

/**
 * WHERE a surface keeps its pick, handed in rather than imported, so the host
 * model below is not welded to one store.
 *
 * Settings owns the original (`settings-host-scope-store`, deliberately not
 * persisted); the header's usage popover owns a second, persisted one. They
 * are separate SELECTIONS on purpose — someone watching one machine's rate
 * limits has not thereby asked to administer it — but they must not become
 * separate host MODELS, because two answers to "what is this host called and
 * can I reach it" is exactly the drift `HostScopeOption` was introduced to
 * end. Everything below this line is therefore shared verbatim.
 */
export interface HostScopeSelection {
  /** `null` means "follow the active host" — not "no host". */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
}

/**
 * The one host-scope hook for Settings. Every host-scoped panel reads this and
 * nothing else, which is what makes the sidebar switcher authoritative rather
 * than one more picker among five.
 */
export function useHostScope(): HostScope {
  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const setScopedHostId = useSettingsHostScopeStore((s) => s.setScopedHostId);
  return useHostScopeFor({ scopedHostId, setScopedHostId });
}

/**
 * The host model itself, over whichever selection the caller owns. Splitting
 * this out from `useHostScope` was the whole change: the rules that make a
 * scope safe — `resolveScopedHost`'s refusal to silently retarget a vanished
 * pick, `transientClientEntry`'s `connectable` gate, `deriveHostScopeStatus` —
 * are properties of reading somebody else's host, not properties of Settings.
 * A second surface that re-derived them would eventually re-derive one of them
 * wrongly.
 */
export function useHostScopeFor(selection: HostScopeSelection): HostScope {
  const ambientClient = useHostClient();
  const binding = useHostBinding();
  // The list itself is shared with every other picker in the app — see
  // `useHostOptions`. What is left here is the SELECTION on top of it, which is
  // the only part Settings and the usage popover own.
  const options = useHostOptions();
  const { hosts, activeHostId, listsResolved, listsFailed, nowMs } = options;

  const { scopedHostId, setScopedHostId } = selection;

  // Still loading is not the same as gone, and a list that FAILED cannot prove
  // a host was removed. Both rules — and the reason the `vanished` verdict is
  // never allowed to resolve silently to the active host — live in
  // `resolveScopedHost`, where a test can reach them.
  const resolved = useMemo(
    () =>
      resolveScopedHost({
        hosts,
        scopedHostId,
        activeHostId,
        listsResolved,
        listsFailed,
      }),
    [hosts, scopedHostId, activeHostId, listsResolved, listsFailed],
  );

  const host = resolved.host;
  const isFollowing =
    resolved.vanishedHostId === null &&
    host !== null &&
    host.hostId === activeHostId;

  // Gated on `connectable`, not on the entry's mere existence: an unavailable
  // entry can still carry a stale URL, and a plan-restricted remote advertises
  // one the server will refuse, so keying on the entry built a live-looking
  // client for a host the status machine was about to call `unreachable`.
  // The rule itself lives in `transientClientEntry`, where a test can reach it.
  const overrideEntry = useMemo(
    () => transientClientEntry(host, isFollowing),
    [isFollowing, host],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  // The transient client is built SYNCHRONOUSLY (`createRequester` is a Proxy),
  // so for a connectable host the only reason one comes back null is a missing
  // request context or unbound user. That is a credential gap, not a connection
  // in progress, and it must not render as a spinner that can never resolve.
  const hasRequestAuthority =
    ambientClient.getRequestContext() !== null &&
    ambientClient.getRequestContextUserId() !== null;

  const status = deriveHostScopeStatus({
    isFollowing,
    host,
    vanishedHostId: resolved.vanishedHostId,
    overrideClient,
    hasRequestAuthority,
    listsResolved,
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
    // `overrideClient` is null for `connecting`, `unreachable` and `vanished`
    // — guaranteed by the `connectable` gate on `overrideEntry` above, not by
    // hope — so only the `following` branch may swap in the ambient client.
    // Any other branch handing back `ambientClient` would be the exact
    // substitution this status enum exists to make impossible.
    client: status === "following" ? ambientClient : overrideClient,
    setHostId: setScopedHostId,
    makeActive: (hostId: string) => {
      binding?.directory.selectById(hostId);
    },
    isLoading: options.isLoading,
    listsFailed,
    retryLists: options.retryLists,
    nowMs,
  };
}
