import {
  keepPreviousData,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostTransportFailureError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostDoctorResponse,
  HostGetInstallationInfoResponse,
  HostServiceDeregisterResponse,
  HostServiceRegisterResponse,
  HostUpdateInstallResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostRestartResponse } from "@traycer/protocol/host/restart/index";
import { useEffect } from "react";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";
import { hostMaintenanceMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";
import { useHostServiceWriteLatchStore } from "@/components/settings/panels/host-service-write-latch-store";
import type { HostRpcRegistry } from "@/lib/host";

/** Every mutation here captures its target at arm time (`onMutate` reads the client's active host id) rather
 * than at settle time. */

const EMPTY_PARAMS = {};

export interface HostOverviewMutationContext {
  readonly hostId: string | null;
}

/** `host.identity.get` - the host's own name, and the only name a reachable host should be displayed under. */
export function useHostIdentityQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}) {
  return useHostQuery<HostRpcRegistry, "host.identity.get">({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "host.identity.get",
    params: EMPTY_PARAMS,
    options: { enabled: input.enabled, staleTime: 30_000 },
  });
}

/** The interval sits comfortably under this query's `staleTime`, which is the other half of the same guarantee. */
export function useHostOverviewStatusQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
  readonly hostId: string | null;
}) {
  return useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "host.status",
    params: EMPTY_PARAMS,
    // A healthy poll refreshes at 10s and never lets the data reach 30s, so `isStale` stays false.
    options: {
      enabled: input.enabled,
      staleTime: 30_000,
      poll: true,
      // Same-host retain-while-refetching so a remount or observer swap cannot empty `data` and unmount the busy
      // chip for a round trip. A host mismatch drops the prior payload (never show host A's work as host B's).
      placeholderData: keepPreviousDataForSameHost(input.hostId),
    },
  });
}

/** Overview has no busy subscription - only a 10s poll - so a terminal-agent that just started can sit
 * invisible on the chip until the next tick. */
export function useRefreshOverviewStatusOnSessionActivity(input: {
  readonly hostId: string | null;
  readonly enabled: boolean;
}): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!input.enabled || input.hostId === null) {
      return;
    }
    const hostId = input.hostId;
    // Snapshot before subscribe so a StrictMode remount (cleanup + re-setup) with unchanged membership does not
    // invalidate.
    let lastSignature = scopedSessionMembershipSignature(hostId);
    const refresh = (): void => {
      const next = scopedSessionMembershipSignature(hostId);
      if (next === lastSignature) return;
      lastSignature = next;
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "host.status"),
      });
    };
    const unsubTerminal = getTerminalSessionRegistry().subscribe(refresh);
    const unsubChat = getChatSessionRegistry().subscribe(refresh);
    return () => {
      unsubTerminal();
      unsubChat();
    };
  }, [input.enabled, input.hostId, queryClient]);
}

function scopedSessionMembershipSignature(hostId: string): string {
  const terminals = getTerminalSessionRegistry()
    .membershipIdsForHost(hostId)
    .join(",");
  const chats = getChatSessionRegistry().membershipIdsForHost(hostId).join(",");
  return `t:${terminals}|c:${chats}`;
}

/** Answers `{status: "unmanaged"}` for a tree-run host rather than failing, and the difference matters on this
 * page. */
export function useHostInstallationInfoQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}) {
  return useHostQuery<HostRpcRegistry, "host.getInstallationInfo">({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "host.getInstallationInfo",
    params: EMPTY_PARAMS,
    options: { enabled: input.enabled, staleTime: 60_000 },
  });
}

/** A mutation rather than a query even though it reads nothing: running doctor spawns a process on the host, so
 * it happens when someone asks for it and not because a component mounted, refocused, or reconnected. */
export function useHostDoctorRun(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostDoctorResponse,
  HostRpcError,
  void,
  HostOverviewMutationContext
> {
  return useHostMutation<
    HostRpcRegistry,
    "host.doctor",
    HostOverviewMutationContext,
    void
  >({
    client,
    method: "host.doctor",
    mapVariables: () => EMPTY_PARAMS,
    options: {
      mutationKey: hostMaintenanceMutationKeys.doctorRun(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
    },
  });
}

/** That is the contract: the same id lets the host adopt a claim it already granted when a retry follows a lost
 * response, while a different id must never adopt someone else's in-flight transition (an update, say). */
export function useHostRestart(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostRestartResponse,
  HostRpcError,
  { readonly transitionId: string },
  HostOverviewMutationContext
> {
  return useHostMutation<
    HostRpcRegistry,
    "host.restart",
    HostOverviewMutationContext,
    { readonly transitionId: string }
  >({
    client,
    method: "host.restart",
    mapVariables: (variables) => ({ transitionId: variables.transitionId }),
    options: {
      mutationKey: hostMaintenanceMutationKeys.restart(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
    },
  });
}

/** Invalidates the identity read for the host captured AT arm time. */
export function useHostIdentitySet(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostIdentity,
  HostRpcError,
  { readonly customName: string | null },
  HostOverviewMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.identity.set",
    HostOverviewMutationContext,
    { readonly customName: string | null }
  >({
    client,
    method: "host.identity.set",
    mapVariables: (variables) => ({ customName: variables.customName }),
    options: {
      mutationKey: hostMaintenanceMutationKeys.identitySet(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "host.identity.get",
          ),
        });
      },
    },
  });
}

/** `staleTime` means reopening the page inside the window reuses the answer instead of re-spawning the CLI;
 * refetch-on-focus is off, so alt-tabbing never triggers one. */
export function useHostUpdateCheckQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
  readonly includePreReleases: boolean | undefined;
}) {
  return useHostQuery<HostRpcRegistry, "host.update.check">({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "host.update.check",
    params:
      input.includePreReleases === undefined
        ? {}
        : { includePreReleases: input.includePreReleases },
    options: {
      enabled: input.enabled,
      // This is the one read on the page that costs a process on the host, and what it returns - which versions the
      // registry publishes - changes on a release cadence, not a browsing one.
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Without it, ticking "Include release candidates" changes the query key, which empties `data` and collapses
      // the list back to its "nothing here yet" copy for the duration of the round trip.
      placeholderData: keepPreviousData,
    },
  });
}

/** A query, unlike the two writes beside it: `host service status` only inspects launchd/systemd/schtasks
 * state, so it is safe to run whenever the section is open and safe to refetch after a write. */
export function useHostServiceStatusQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}) {
  return useHostQuery<HostRpcRegistry, "host.service.status">({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "host.service.status",
    params: EMPTY_PARAMS,
    options: { enabled: input.enabled, staleTime: 30_000 },
  });
}

/** Invalidates the status read and `host.status` for the arm-time host, because on macOS this is a
 * bootout/bootstrap cycle: the host that answers afterwards is a new process. */
export function useHostServiceRegister(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostServiceRegisterResponse,
  HostRpcError,
  void,
  HostOverviewMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.service.register",
    HostOverviewMutationContext,
    void
  >({
    client,
    method: "host.service.register",
    mapVariables: () => EMPTY_PARAMS,
    options: {
      mutationKey: hostMaintenanceMutationKeys.serviceRegister(),
      // Lost settles therefore fail safe - the latch over-locks until its bounded timer - instead of failing open
      // with live controls over a restarting host.
      onMutate: () => {
        const hostId = client?.getActiveHostId() ?? null;
        if (hostId !== null) {
          useHostServiceWriteLatchStore
            .getState()
            .armRegisterRestartLikely(hostId);
        }
        return { hostId };
      },
      onSuccess: (response, _variables, context) => {
        if (context.hostId === null) return;
        const latchStore = useHostServiceWriteLatchStore.getState();
        // An answer arrived over a live connection - whatever it says, the bootout-restart shape (which never answers)
        // did not happen.
        latchStore.releaseRegisterRestartLikely(context.hostId);
        if (response.outcome === "externally-managed") {
          latchStore.armExternallyManagedRefusal(context.hostId);
        }
        if (response.outcome !== "ok") return;
        for (const method of ["host.service.status", "host.status"] as const) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error, _variables, context) => {
        if (context === undefined || context.hostId === null) return;
        if (!(error instanceof HostTransportFailureError)) {
          // A real refusal or host error, not the restart shape: release the
          // dispatch-armed latch, there is no restart to guard.
          useHostServiceWriteLatchStore
            .getState()
            .releaseRegisterRestartLikely(context.hostId);
          return;
        }
        // The caches must not be left describing the pre-register service, and `refetchType: "none"` is what makes
        // this stale-only.
        for (const method of ["host.service.status", "host.status"] as const) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
            refetchType: "none",
          });
        }
      },
    },
  });
}

/** `accepted` means the CLI was dispatched detached; the host then dies, so there is nothing left to refetch
 * from and a refetch would only produce a connection error the user did not cause. */
export function useHostServiceDeregister(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostServiceDeregisterResponse,
  HostRpcError,
  void,
  HostOverviewMutationContext
> {
  return useHostMutation<
    HostRpcRegistry,
    "host.service.deregister",
    HostOverviewMutationContext,
    void
  >({
    client,
    method: "host.service.deregister",
    mapVariables: () => EMPTY_PARAMS,
    options: {
      mutationKey: hostMaintenanceMutationKeys.serviceDeregister(),
      // Same dispatch-arm / settle-release inversion as register's restart latch, for the same reason.
      onMutate: () => {
        const hostId = client?.getActiveHostId() ?? null;
        if (hostId !== null) {
          useHostServiceWriteLatchStore
            .getState()
            .armDeregisterAccepted(hostId);
        }
        return { hostId };
      },
      onSuccess: (response, _variables, context) => {
        if (context.hostId === null) return;
        const latchStore = useHostServiceWriteLatchStore.getState();
        if (response.outcome === "externally-managed") {
          latchStore.armExternallyManagedRefusal(context.hostId);
        }
        // Any answer other than accepted refutes the dispatch-armed latch: nothing was dispatched, nothing is shutting
        // down.
        if (response.outcome !== "accepted") {
          latchStore.releaseDeregisterAccepted(context.hostId);
        }
      },
      onError: (error, _variables, context) => {
        if (context === undefined || context.hostId === null) return;
        // Releasing here would re-enable lifecycle controls over a host that is shutting down, so the dispatch-armed
        // latch stays held - its bounded timer backstops the case where nothing was dispatched at all.
        if (error instanceof HostTransportFailureError) return;
        useHostServiceWriteLatchStore
          .getState()
          .releaseDeregisterAccepted(context.hostId);
      },
    },
  });
}

/** `host.update.install` - start the CLI-owned, detached update swap. */
export function useHostUpdateInstall(
  client: HostClient<HostRpcRegistry> | null,
  // The `dispatch-indeterminate` arm is a new discriminant rather than a new field, so it is not assignable to
  // anything in @1.0 and the annotation stopped being quietly wrong and started being loudly wrong.
): UseMutationResult<
  HostUpdateInstallResponseV11,
  HostRpcError,
  { readonly version: string; readonly force: boolean },
  HostOverviewMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.update.install",
    HostOverviewMutationContext,
    { readonly version: string; readonly force: boolean }
  >({
    client,
    method: "host.update.install",
    mapVariables: (variables) => ({
      version: variables.version,
      force: variables.force,
    }),
    options: {
      mutationKey: hostMaintenanceMutationKeys.updateInstall(),
      // Same dispatch-arm / settle-release inversion as the service writes: `accepted` settles before
      // `updateProgress` exists, and that gap must stay locked even if the settle is lost to a host-keyed unmount.
      onMutate: () => {
        const hostId = client?.getActiveHostId() ?? null;
        if (hostId !== null) {
          useHostServiceWriteLatchStore
            .getState()
            .armUpdateInstallAccepted(hostId);
        }
        return { hostId };
      },
      // Uses the arm-time host id, so the refresh lands on the host that is actually updating rather than whichever
      // one the picker has reached.
      onSuccess: (response, _variables, context) => {
        if (context.hostId === null) return;
        // An update may well be running - we simply cannot tie it to this call.
        if (response.outcome === "dispatch-indeterminate") {
          useHostServiceWriteLatchStore
            .getState()
            .releaseUpdateInstallAccepted(context.hostId);
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, "host.status"),
          });
          return;
        }
        if (
          response.outcome !== "accepted" &&
          response.outcome !== "already-updating"
        ) {
          // A refusal: no swap was dispatched, nothing to guard.
          useHostServiceWriteLatchStore
            .getState()
            .releaseUpdateInstallAccepted(context.hostId);
          return;
        }
        // The refresh below is how the progress row appears once the CLI reports it, and the panel's release effect
        // (or the bounded timer) unwinds the latch from there.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "host.status"),
        });
      },
      onError: (_error, _variables, context) => {
        if (context === undefined || context.hostId === null) return;
        useHostServiceWriteLatchStore
          .getState()
          .releaseUpdateInstallAccepted(context.hostId);
      },
    },
  });
}

/** Narrowing helper so callers read the managed arm without re-checking. */
export function managedInstallation(
  response: HostGetInstallationInfoResponse | undefined,
): Extract<
  HostGetInstallationInfoResponse,
  { readonly status: "managed" }
> | null {
  if (response === undefined || response.status !== "managed") return null;
  return response;
}
