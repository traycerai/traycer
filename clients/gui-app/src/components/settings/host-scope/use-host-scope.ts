import { useCallback, useMemo, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { createLocalMaintenanceFallbackClient } from "@/lib/host/local-maintenance-fallback-client";
import type {
  ActivateRefusalReason,
  ActivateResult,
  SelectionAuthorityClient,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { toast } from "sonner";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger } from "@/lib/logger";
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
  readonly hosts: readonly HostScopeOption[];
  readonly host: HostScopeOption | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The id that was picked but is no longer listed - only when `vanished`. */
  readonly vanishedHostId: string | null;
  readonly returnToActive: () => void;
  readonly activeHostId: string | null;
  readonly activeHost: HostScopeOption | null;
  readonly isViewingActive: boolean;
  readonly status: HostScopeStatus;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Enablement must read this same flag (`resolveOverviewMethodDegrade`) so a control is live exactly when the
   * client would serve its method. */
  readonly localMaintenanceFallback: boolean;
  readonly setHostId: (hostId: string) => void;
  /** Activate: the app's one and only writer of `preferredHostId` (selection model §1, invariant 1). */
  readonly makeActive: (hostId: string) => void;
  /** The button must gate on this. */
  readonly isActivating: boolean;
  readonly isLoading: boolean;
  /** A host list came back as an error, so an empty `hosts` means "we could not find out", not "you own no
   * machines". */
  readonly listsFailed: boolean;
  /** Re-request both host lists after a failure. */
  readonly retryLists: () => void;
  readonly nowMs: number;
}

/** They are separate selections on purpose - someone watching one machine's rate limits has not thereby asked
 * to administer it - but they must not become separate host models. */
export interface HostScopeSelection {
  readonly scopedHostId: string | null;
  readonly setScopedHostId: (hostId: string | null) => void;
}

/** Every host-scoped panel reads this and nothing else, which is what makes the sidebar switcher authoritative
 * rather than one more picker among five. */
export function useHostScope(): HostScope {
  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const setScopedHostId = useSettingsHostScopeStore((s) => s.setScopedHostId);
  return useHostScopeFor({ scopedHostId, setScopedHostId });
}

/** Splitting this out from `useHostScope` was the whole change: the rules that make a scope safe. */
export function useHostScopeFor(selection: HostScopeSelection): HostScope {
  const ambientClient = useHostClient();
  const runnerHost = useRunnerHost();
  // What is left here is the selection on top of it, which is the only part Settings and the usage popover own.
  const options = useHostOptions();
  const { hosts, activeHostId, listsResolved, listsFailed, nowMs } = options;

  const { scopedHostId, setScopedHostId } = selection;
  const authority = runnerHost.selectionAuthority;
  // One activation at a time, and the guard is here rather than only on the button: the button is one caller,
  // and this is the seam every caller passes through.
  const [activatingHostId, setActivatingHostId] = useState<string | null>(null);
  // Guarding on the state value reads it through this callback's closure, which only refreshes on re-render - so
  // two clicks delivered in one React batch both see `null` and both write.
  const activatingRef = useRef(false);
  const makeActive = useCallback(
    (hostId: string) => {
      if (activatingRef.current) return;
      const option = findHostOption(hosts, hostId);
      activatingRef.current = true;
      setActivatingHostId(hostId);
      void requestActivate(authority, hostId, option).finally(() => {
        activatingRef.current = false;
        setActivatingHostId(null);
      });
    },
    [authority, hosts],
  );

  // Both rules - and the reason the `vanished` verdict is never allowed to resolve silently to the active host -
  // live in `resolveScopedHost`, where a test can reach them.
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

  // Gated on `connectable`, not on the entry's mere existence.
  const overrideEntry = useMemo(
    () => transientClientEntry(host, isFollowing),
    [isFollowing, host],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  // That is a credential gap, not a connection in progress, and it must not render as a spinner that can never
  // resolve.
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

  // `overrideClient` is null for `connecting`, `unreachable` and `vanished` - guaranteed by the `connectable`
  // gate on `overrideEntry` above, not by hope - so only the `following` branch may swap in the ambient client.
  const resolvedClient =
    status === "following" ? ambientClient : overrideClient;

  // Fail-closed gates: this machine's local host only (`isLocalMachine ?? false` is the row's own fail-closed
  // read), and only where a `hostManagement` bridge exists (never in a browser shell, never for a remote scope).
  const fallbackHostId =
    host !== null && host.isLocalMachine ? host.hostId : null;
  const hostManagement = runnerHost.hostManagement;
  const client = useMemo(() => {
    if (
      resolvedClient === null ||
      fallbackHostId === null ||
      hostManagement === null
    ) {
      return resolvedClient;
    }
    return createLocalMaintenanceFallbackClient({
      client: resolvedClient,
      localHostId: fallbackHostId,
      management: hostManagement,
    });
  }, [resolvedClient, fallbackHostId, hostManagement]);

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
    client,
    localMaintenanceFallback: client !== null && client !== resolvedClient,
    setHostId: setScopedHostId,
    makeActive,
    isActivating: activatingHostId !== null,
    isLoading: options.isLoading,
    listsFailed,
    retryLists: options.retryLists,
    nowMs,
  };
}

/** A refusal is a real answer about a host, not a transport failure, so each one says what the user can do
 * about it instead of a generic error. */
export async function requestActivate(
  authority: SelectionAuthorityClient,
  hostId: string,
  option: HostScopeOption | null,
): Promise<void> {
  let result: ActivateResult;
  try {
    result = await authority.activate(hostId);
  } catch (error: unknown) {
    appLogger.warn("[host-scope] activate request failed", {
      hostId,
      error: String(error),
    });
    toast.error("Couldn't activate this host. Try again.");
    return;
  }
  if (result.ok) {
    Analytics.getInstance().track(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: option?.isLocalMachine === true ? "local" : "remote",
    });
    return;
  }
  toast.error(
    activateRefusalMessage(result.reason, option?.name ?? "That host"),
  );
}

/** A `Record` keyed on `ActivateRefusalReason` is the census. */
const ACTIVATE_REFUSAL_COPY: Record<
  ActivateRefusalReason,
  (label: string) => string
> = {
  "unknown-host": (label) =>
    `${label} is no longer registered to this account.`,
  incompatible: (label) =>
    `${label} needs a host update before it can be activated.`,
  "not-attached": () =>
    "This window lost its connection to the selection service - reload and try again.",
  // Nothing moved: the preference was refused before any state changed and no event fired, so the same Activate
  // is safe to retry verbatim - which is why this says "try again" and not "it may or may not have applied".
  "persist-failed": () => "Couldn't save your choice - try again.",
  unrecognized: (label) => `Couldn't activate ${label}.`,
};

function activateRefusalMessage(
  reason: ActivateRefusalReason,
  label: string,
): string {
  return ACTIVATE_REFUSAL_COPY[reason](label);
}
