import {
  keepPreviousData,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostTransportFailureError,
  type HostRpcError,
  type ResponseOfMethod,
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
import {
  isLiveOverviewIncarnation,
  useHostServiceWriteLatchStore,
} from "@/components/settings/panels/host-service-write-latch-store";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The Overview's whole host-RPC surface, in one place.
 *
 * Every mutation here captures its target at ARM time (`onMutate` reads the
 * client's active host id) rather than at settle time. The page can be
 * re-scoped to another machine while a restart or a rename is in flight, and a
 * success handler that read "the current host" afterwards would credit one
 * host's write to another — the same class of substitution the scope model
 * exists to prevent, just moved into the time dimension.
 *
 * Reads are gated by the caller, never by this module: whether a host is worth
 * asking is a question about the scope's status and the negotiated manifest,
 * and both live with the panel that owns the gate.
 */

const EMPTY_PARAMS = {};

export interface HostOverviewMutationContext {
  readonly hostId: string | null;
}

/**
 * `host.identity.get` — the host's own name, and the ONLY name a reachable host
 * should be displayed under.
 *
 * `effectiveName` is the field to render; `systemName`/`customName` exist so the
 * edit form can tell "no override set" from "override happens to equal the
 * machine name", which is what makes Reset meaningful.
 */
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

/**
 * `host.status` — the process's own answer about itself.
 *
 * Released-floor, so every host answers it: this is what lets the status card
 * report a version and a session count for a host far too old to have any of
 * the methods around it.
 *
 * Polled, not merely stale-timed. Its `busySessionCount` / `busyBreakdown` is
 * what the drain affordance names in "Apply now — ends 2 agents and 1
 * terminal" (or "ends N sessions" on a @1.1 host) and then destroys, so the
 * question is not "may we reuse this value" but "is this value still true".
 * Going stale does not refetch on its own, so without an interval a focused
 * Overview could sit for minutes serving the count it read on mount.
 *
 * The interval sits comfortably under this query's `staleTime`, which is the
 * other half of the same guarantee: the interval keeps a healthy read fresh,
 * and `isStale` demotes an unhealthy one to `null` rather than letting it look
 * live.
 * This is a host RPC over an already-open connection, not a cloud endpoint —
 * it costs nothing the connection was not already paying, and only while this
 * panel is mounted.
 */
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
    // `staleTime` deliberately EXCEEDS the poll interval. A healthy poll
    // refreshes at 10s and never lets the data reach 30s, so `isStale` stays
    // false; if the interval stops firing or refetches keep failing, the value
    // ages out and `isStale` becomes the signal that demotes the drain count
    // to `null`. Inverting these two would make a healthy query flicker
    // between live and unknown on every tick.
    options: {
      enabled: input.enabled,
      staleTime: 30_000,
      poll: true,
      // Same-host retain-while-refetching so a remount or observer swap
      // cannot empty `data` and unmount the busy chip for a round trip.
      // A host mismatch drops the prior payload (never show host A's work
      // as host B's).
      placeholderData: keepPreviousDataForSameHost(input.hostId),
    },
  });
}

/**
 * Refetch `host.status` when THIS host's chat or terminal session
 * membership changes.
 *
 * Overview has no busy subscription — only a 10s poll — so a terminal-agent
 * that just started can sit invisible on the chip until the next tick.
 * Membership is the event the GUI already has: a new (or gone) session is
 * exactly when host-side `busyBreakdown` is likely to have moved. Per-handle
 * status changes on an already-registered session still wait for the poll;
 * that lag is host-side accounting, not a missing client invalidation.
 *
 * Registries are process-wide, so a notify fires for every host. Invalidating
 * host A's `host.status` on host B's membership momentarily voids SETTLED
 * busy (and can disable "Apply now"). Compare a host-scoped snapshot and
 * skip the invalidate when this host's entries did not move.
 */
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
    // Snapshot BEFORE subscribe so a StrictMode remount (cleanup + re-setup)
    // with unchanged membership does not invalidate.
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

/**
 * `host.getInstallationInfo` — the install record as the HOST reads it.
 *
 * Answers `{status: "unmanaged"}` for a tree-run host rather than failing, and
 * the difference matters on this page: "no install record" is a legitimate,
 * describable state (someone is running the host from a checkout), not an
 * error, and rendering it as one would put a red box on every dev machine.
 *
 * Polled (table-owned cadence, 10s), not merely stale-timed, because the
 * Overview now DERIVES from it: the install record against the running
 * version is what says "installed, restart to finish", and the staged record
 * beside a busy host is what says "staged, waiting for work". Both change
 * under a mounted page through actors this client never sees - a detached CLI
 * run, the desktop's launch converge - and a 60s staleTime with no interval
 * observed neither until the page was remounted. `staleTime` still exceeds
 * the interval so a healthy poll never reads as stale.
 *
 * Keyed by the RUNNING version the caller has observed. The facts derived
 * from this read are comparisons against that version, and a version change
 * is exactly the moment the install record moved under the page (the host
 * restarted onto new bytes): a payload fetched under the old version is not
 * a stale answer to the same question, it is an answer to a different one,
 * and TanStack would otherwise keep serving it - "installed X, running Y,
 * restart to finish" for a host that just finished. A new key has no data
 * until the fresh read answers, which the derivation reads as "not observed".
 * Disabled until a running version is known for the same reason.
 */
export function useHostInstallationInfoQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
  readonly runningVersion: string | null;
}) {
  return useHostQuery<HostRpcRegistry, "host.getInstallationInfo">({
    cacheKeyIdentity: [input.runningVersion],
    client: input.client,
    method: "host.getInstallationInfo",
    params: EMPTY_PARAMS,
    options: {
      enabled: input.enabled && input.runningVersion !== null,
      staleTime: 60_000,
      poll: true,
    },
  });
}

/**
 * `host.doctor` — the host shells its own CLI and hands back the report.
 *
 * A mutation rather than a query even though it reads nothing: running doctor
 * spawns a process on the host, so it happens when someone asks for it and not
 * because a component mounted, refocused, or reconnected.
 */
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

/**
 * `host.restart` — claim-gated, ack-before-exit.
 *
 * `transitionId` is generated by the CALLER at arm time and passed in, not
 * minted here. That is the contract: the same id lets the host adopt a claim it
 * already granted when a retry follows a lost response, while a DIFFERENT id
 * must never adopt someone else's in-flight transition (an update, say) — so a
 * fresh id per attempt would turn an idempotent retry into a busy refusal, and
 * a process-wide constant would let this button adopt a transition it did not
 * start.
 *
 * Both outcomes RESOLVE. `busy` is not an error: the host deliberately refused
 * because work is in flight, it reopened admission, and a later retry succeeds
 * on its own. Routing it through the error channel would put a red toast and a
 * report-issue affordance on a completely healthy negotiation.
 */
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

/**
 * `host.identity.set` — write (or clear, with `null`) the custom name.
 *
 * Invalidates the identity read for the host CAPTURED AT ARM TIME. Using the
 * live scope here would refresh the wrong host's name after a mid-flight scope
 * change and leave the renamed host showing its old name until something else
 * happened to refetch it.
 */
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

/**
 * `host.update.check` — the host shells `host available --json`.
 *
 * A QUERY, and it did not start as one. This was a mutation for the same reason
 * `host.doctor` is: it spawns a process on someone else's machine and reaches
 * the release registry over the network, so it should happen when a person asks
 * rather than because a settings pane mounted.
 *
 * What overrode that is the surface it feeds. "Pick a different version" sat
 * empty under a heading that promised a list, next to a release-candidate
 * checkbox that also did nothing, inside a disclosure you had already opened in
 * order to see versions — and the only thing that would fill it was a button in
 * a different region of the page. A control that needs a second, unrelated
 * action before it can show anything reads as broken, not as deferred.
 *
 * The cost is bounded rather than accepted wholesale. `staleTime` means
 * reopening the page inside the window reuses the answer instead of re-spawning
 * the CLI; refetch-on-focus is off, so alt-tabbing never triggers one; and the
 * poll table already schedules this method `latest`, so a burst collapses to the
 * newest question rather than queueing.
 *
 * `includePreReleases` rides in `params`, which puts it in the QUERY KEY: the
 * THREE catalog states are three cache entries, so changing the filter asks a
 * genuinely different question and can never show one filter's list under
 * another's label. A host too old to know the field ignores it and answers with
 * the stable list — see the request schema for why that degrades to a filter
 * that appears not to work rather than to an error.
 *
 * The derive state OMITS the key rather than sending a value for it, and both
 * halves of that matter. On the wire it is what the v1.1 request schema
 * requires: within one major there is no request-downgrade bridge, so a v1.1
 * client on a v1.0 host projects by parsing with the older schema, and a
 * literal `null` would fail that parse and turn every default catalog load
 * against an already-shipped host into `DOWNGRADE_UNSUPPORTED`. In the cache it
 * keeps the default's key distinct from explicit-exclude's, which is the whole
 * point of the tri-state — on an RC host those two produce different lists.
 */
export function useHostUpdateCheckQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
  /** `undefined` = follow the host's derived default. */
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
      // Long, deliberately. This is the one read on the page that costs a
      // process on the host, and what it returns — which versions the registry
      // publishes — changes on a release cadence, not a browsing one. The one
      // exception — re-asking while the answer is `cli-unavailable`, so a
      // reinstalled CLI revives the retired region — is table-owned condition
      // polling (`host-method-policy-table.ts`), not an option here.
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Keeps the PREVIOUS filter's list on screen while the new one loads.
      // Without it, ticking "Include release candidates" changes the query key,
      // which empties `data` and collapses the list back to its "nothing here
      // yet" copy for the duration of the round trip — the checkbox would read
      // as having cleared the list rather than re-asked for it.
      placeholderData: keepPreviousData,
    },
  });
}

/**
 * `host.service.status` — the OS service registration, read from the host.
 *
 * A QUERY, unlike the two writes beside it: `host service status` only inspects
 * launchd/systemd/schtasks state, so it is safe to run whenever the section is
 * open and safe to refetch after a write. That asymmetry is the reason the three
 * are separate methods at all.
 */
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

/**
 * `host.service.register` — re-register the OS service supervising this host.
 *
 * Invalidates the status read AND `host.status` for the arm-time host, because
 * on macOS this is a bootout/bootstrap cycle: the host that answers afterwards
 * is a new process. Both invalidations are hook-level for the reason
 * `useHostUpdateInstall` documents — the cycle easily outlives a Settings scope
 * change, and TanStack drops per-`mutate` callbacks once the observer is gone.
 */
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
      // The restart latch arms at DISPATCH, not at the transport-drop settle:
      // `onMutate` is the one callback that cannot be lost, while every settle
      // callback dies with the observer when the host-keyed panel unmounts
      // mid-flight. Lost settles therefore fail SAFE - the latch over-locks
      // until its bounded timer - instead of failing open with live controls
      // over a restarting host. The settles below RELEASE it on every answer
      // that refutes a restart.
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
        // An ANSWER arrived over a live connection - whatever it says, the
        // bootout-restart shape (which never answers) did not happen.
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
        // The transport DROPPED - the probable-success restart. The latch
        // stays armed (dispatch armed it). The caches must not be left
        // describing the pre-register service, and `refetchType: "none"` is
        // what makes this stale-only: the default refetches active observers
        // immediately, against a socket this very branch just proved is down.
        // The refresh arrives through the latch's release paths (scope flip,
        // or the bounded timer's explicit refetch) once the restarted host
        // answers.
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

/**
 * `host.service.deregister` — stop supervising this host, and stop the host.
 *
 * No invalidation on success, deliberately. `accepted` means the CLI was
 * dispatched detached; the host then dies, so there is nothing left to refetch
 * from and a refetch would only produce a connection error the user did not
 * cause. What comes next is the scope going unreachable, which the page already
 * describes on its own.
 */
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
      // Same dispatch-arm / settle-release inversion as register's restart
      // latch, for the same reason: the settle can be lost to a host-keyed
      // unmount, and a lost settle must over-lock briefly (bounded timer),
      // never fail open while the detached CLI is stopping the host.
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
        // Any answer OTHER than accepted refutes the dispatch-armed latch:
        // nothing was dispatched, nothing is shutting down. `accepted` keeps
        // it - that is the state the latch exists for.
        if (response.outcome !== "accepted") {
          latchStore.releaseDeregisterAccepted(context.hostId);
          return;
        }
        // THE DISPATCH SLOT'S FOURTH CLEAR (D8): the host service is going
        // away, and an update dispatch is a claim about a host that will be
        // there to park. Keeping the slot would mean a re-register of the same
        // `hostId` — the same string, a freshly installed service — inherits an
        // activation offer made about the service that was removed, and opens
        // a dialog for it on the first matching frame.
        //
        // Cleared on the ACCEPTED answer rather than beside the arm above,
        // even though the latch itself is armed pessimistically at dispatch:
        // over-locking controls for a bounded moment is a safe default, but
        // discarding ownership is not reversible, and a refused deregister
        // leaves a host whose dispatch is still perfectly good.
        latchStore.clearUpdateDispatch(context.hostId);
      },
      onError: (error, _variables, context) => {
        if (context === undefined || context.hostId === null) return;
        // A transport DROP is deregister's probable-dispatch shape, exactly as
        // it is register's: the request can reach the host and start the
        // detached CLI just as the supervised process exits, losing the
        // `accepted` answer. Releasing here would re-enable lifecycle controls
        // over a host that is shutting down, so the dispatch-armed latch stays
        // held — its bounded timer backstops the case where nothing was
        // dispatched at all. Only an error that definitively PRECEDED
        // execution refutes the dispatch.
        if (error instanceof HostTransportFailureError) return;
        useHostServiceWriteLatchStore
          .getState()
          .releaseDeregisterAccepted(context.hostId);
      },
    },
  });
}

/**
 * `host.update.install` — start the CLI-owned, detached update swap.
 *
 * Every arm of the response resolves, including the refusals: `externally-managed`
 * is a correct answer from a correctly-configured host (its updates are driven
 * from outside), and `cli-unavailable` / `cli-failed` describe what happened
 * when the host tried, not a broken connection. Progress afterwards is NOT
 * reported here — it surfaces on `host.status`'s `updateProgress`, because the
 * swap outlives this request by design.
 */
export function useHostUpdateInstall(
  client: HostClient<HostRpcRegistry> | null,
  /**
   * The dispatching `HostOverviewPanel` mount's token (D8). Captured in
   * `onMutate` and compared at settle, so ownership is written only while the
   * mount that asked is still on screen — see {@link settleUpdateDispatch}.
   */
  incarnation: string,
  // The @1.1 response type, which is what this client's registry negotiates
  // and therefore what callers actually receive. Annotating the @1.0 type here
  // used to compile only by accident: `attemptId` is an EXTRA property, and an
  // arm with extra properties stays assignable to the arm without them. The
  // `dispatch-indeterminate` arm is a new discriminant rather than a new field,
  // so it is not assignable to anything in @1.0 and the annotation stopped
  // being quietly wrong and started being loudly wrong — which is the better
  // failure, and the reason to name the version explicitly now.
): UseMutationResult<
  HostUpdateInstallResponseV11,
  HostRpcError,
  { readonly version: string; readonly force: boolean },
  HostUpdateDispatchContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.update.install",
    HostUpdateDispatchContext,
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
      // Same dispatch-arm / settle-release inversion as the service writes:
      // `accepted` settles before `updateProgress` exists, and that gap must
      // stay locked even if the settle is lost to a host-keyed unmount.
      onMutate: () => armUpdateDispatchMutation(client, incarnation),
      // HOOK-level, not in the caller's per-`mutate` callbacks.
      //
      // The swap is detached and outlives this response, so
      // `host.status.updateProgress` is what reports it and the read has to be
      // refreshed. An install is long enough for the user to switch Settings
      // scope, which remounts the panel under its host key and destroys the
      // observer - and TanStack does not run per-`mutate` callbacks after
      // that. The invalidation would then be skipped entirely, and coming back
      // to that host inside the 15s stale window showed the old version with
      // no progress row.
      //
      // Uses the ARM-TIME host id, so the refresh lands on the host that is
      // actually updating rather than whichever one the picker has reached.
      onSuccess: (response, _variables, context) => {
        // AN UNRESOLVED DISPATCH IS ITS OWN ANSWER, and it is classified apart
        // from the refusals below rather than folded into them.
        //
        // Both release the latch, so this arm could be left to the
        // `!== accepted && !== already-updating` test and would behave
        // correctly today. It is written out anyway because that test's comment
        // says "no swap was dispatched" — which is the one thing
        // `dispatch-indeterminate` explicitly does not claim. A future reader
        // reconciling the arm with that comment would reasonably conclude the
        // arm was mis-filed and move it in with the armed outcomes, which is
        // precisely the mistake the O3 ruling forbids: the latch is a 60s
        // lockout, it belongs to `accepted` alone, and arming it over an
        // outcome that is not an acceptance freezes the controls a person needs
        // for a minute over a dispatch nobody can attribute.
        //
        // It also does something the refusal branch does not: it REFRESHES
        // `host.status`. An update may well be running — we simply cannot tie
        // it to this call — and observation through `updateOperation` is the
        // negotiated route to that fact, so the read that would reveal it has
        // to be re-armed rather than skipped.
        //
        // `already-updating` keeps the latch exactly as `accepted` does:
        // SOMEONE'S swap is running — another window's, a direct CLI
        // caller's — inside the same blind gap before the CLI writes
        // `updateProgress`, which is the precise window the latch covers.
        // Releasing there would re-enable restart and the service verbs
        // against that active swap.
        settleUpdateDispatch(
          queryClient,
          context,
          classifyInstallOutcome(response),
        );
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

/**
 * `host.update.activate {attemptId, force}` — restart into bytes an attempt
 * has already placed.
 *
 * A distinct METHOD rather than an intent field on `host.update.install`, and
 * that is the whole authorization story: a host too old to know it lacks it, so
 * the transport refuses the dispatch outright and the GUI keeps its legacy
 * routes instead of projecting this request onto a shape that would silently
 * become a plain install. Nothing here consults the release catalog — an
 * activation places no bytes, so there is no version to verify and no CLI floor
 * to clear.
 */
export function useHostUpdateActivate(
  client: HostClient<HostRpcRegistry> | null,
  incarnation: string,
): UseMutationResult<
  BoundDispatchResponse,
  HostRpcError,
  BoundDispatchVariables,
  HostUpdateDispatchContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.update.activate",
    HostUpdateDispatchContext,
    BoundDispatchVariables
  >({
    client,
    method: "host.update.activate",
    mapVariables: (variables) => ({
      attemptId: variables.attemptId,
      force: variables.force,
    }),
    options: boundDispatchOptions(client, queryClient, incarnation),
  });
}

/**
 * `host.update.continue {attemptId, force}` — carry on with whatever this
 * attempt was already authorized to do.
 *
 * Also catalog-free, for a different reason than activate's: the bytes this
 * resumes were authorized when the attempt was created, and a downgrade park
 * re-downloads the SAME version it was created for. Re-deriving a target from
 * the catalog here would be a second opinion about a decision the record
 * already owns — and one a stale UI could get wrong.
 */
export function useHostUpdateContinue(
  client: HostClient<HostRpcRegistry> | null,
  incarnation: string,
): UseMutationResult<
  BoundDispatchResponse,
  HostRpcError,
  BoundDispatchVariables,
  HostUpdateDispatchContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "host.update.continue",
    HostUpdateDispatchContext,
    BoundDispatchVariables
  >({
    client,
    method: "host.update.continue",
    mapVariables: (variables) => ({
      attemptId: variables.attemptId,
      force: variables.force,
    }),
    options: boundDispatchOptions(client, queryClient, incarnation),
  });
}

/**
 * Both bound methods answer the same union, so the two mutations share one set
 * of settle callbacks — and, deliberately, ONE mutation key with the install.
 *
 * The shared key is what makes "an update dispatch is in flight for this host"
 * a single question whatever the intent behind it. Three keys would let the
 * page grey its controls for an install and leave them live for an activation,
 * which is the same dispatch race with a different verb on it.
 */
function boundDispatchOptions(
  client: HostClient<HostRpcRegistry> | null,
  queryClient: QueryClient,
  incarnation: string,
): {
  readonly mutationKey: readonly string[];
  readonly onMutate: () => HostUpdateDispatchContext;
  readonly onSuccess: (
    response: BoundDispatchResponse,
    variables: unknown,
    context: HostUpdateDispatchContext,
  ) => void;
  readonly onError: (
    error: unknown,
    variables: unknown,
    context: HostUpdateDispatchContext | undefined,
  ) => void;
} {
  return {
    mutationKey: hostMaintenanceMutationKeys.updateInstall(),
    onMutate: () => armUpdateDispatchMutation(client, incarnation),
    onSuccess: (response, _variables, context) => {
      settleUpdateDispatch(
        queryClient,
        context,
        classifyBoundDispatchOutcome(response),
      );
    },
    onError: (_error, _variables, context) => {
      if (context === undefined || context.hostId === null) return;
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted(context.hostId);
    },
  };
}

/** The request both bound methods take, as the page's callers express it. */
export interface BoundDispatchVariables {
  readonly attemptId: string;
  readonly force: boolean;
}

/**
 * Named through the registry rather than imported from the protocol's schema
 * module: both bound methods have exactly one minor, so what this client
 * negotiates IS the 1.0 shape and there is no version to state explicitly (the
 * install's annotation exists precisely because it has three).
 */
export type BoundDispatchResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.update.activate"
>;

/**
 * What every update dispatch's settle needs, whatever its method.
 *
 * `hostId` is captured at ARM time for the reason this module's header states.
 * `incarnation` is captured for a narrower one: the settle can outlive the
 * mount, on purpose, and one of the things it does must not.
 */
export interface HostUpdateDispatchContext {
  readonly hostId: string | null;
  readonly incarnation: string;
}

function armUpdateDispatchMutation(
  client: HostClient<HostRpcRegistry> | null,
  incarnation: string,
): HostUpdateDispatchContext {
  const hostId = client?.getActiveHostId() ?? null;
  if (hostId !== null) {
    useHostServiceWriteLatchStore.getState().armUpdateInstallAccepted(hostId);
  }
  return { hostId, incarnation };
}

/**
 * The three things a dispatch's answer decides, reduced to one vocabulary so
 * the install and the two bound methods cannot drift on them.
 *
 * `attemptId` rides on `accepted` alone. `already-updating` names an attempt
 * too — someone else's, by definition — and claiming ownership of it would put
 * this page's activation dialog in front of a person for a dispatch they did
 * not make.
 */
type UpdateDispatchSettlement =
  | { readonly kind: "accepted"; readonly attemptId: string | null }
  | { readonly kind: "already-updating" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "refused" };

function classifyInstallOutcome(
  response: HostUpdateInstallResponseV11,
): UpdateDispatchSettlement {
  if (response.outcome === "accepted") {
    return { kind: "accepted", attemptId: response.attemptId };
  }
  if (response.outcome === "already-updating")
    return { kind: "already-updating" };
  if (response.outcome === "dispatch-indeterminate") {
    return { kind: "indeterminate" };
  }
  return { kind: "refused" };
}

function classifyBoundDispatchOutcome(
  response: BoundDispatchResponse,
): UpdateDispatchSettlement {
  if (response.outcome === "accepted") {
    // Non-nullable on this schema, unlike the install's: these methods are new
    // at 1.0, so there is no peer that predates attempt ids to accommodate.
    return { kind: "accepted", attemptId: response.attemptId };
  }
  if (response.outcome === "already-updating")
    return { kind: "already-updating" };
  if (response.outcome === "dispatch-indeterminate") {
    return { kind: "indeterminate" };
  }
  // `cli-failed`: the host tried and the CLI it spawned refused. Nothing was
  // dispatched, so this is a refusal — the reason reaches the user through the
  // caller's own settle, which is where the page's copy lives.
  return { kind: "refused" };
}

/**
 * The latch, the invalidations and the ownership write, in the one order they
 * are allowed to happen in.
 *
 * ⚠ THE OWNERSHIP WRITE IS INCARNATION-GATED AND NOTHING ELSE IS. This settle
 * deliberately runs after the panel unmounts — that is how a swap the user
 * navigated away from still settles its latch and still invalidates the reads
 * that would otherwise show a stale version — and both of those must keep
 * happening for a retired mount. The slot must not: its only consumer is a
 * one-shot dialog that a mount opens, so writing it for a mount that is gone
 * would leave a stale grant for the NEXT mount to act on, opening a modal
 * nobody asked for.
 */
function settleUpdateDispatch(
  queryClient: QueryClient,
  context: HostUpdateDispatchContext,
  settlement: UpdateDispatchSettlement,
): void {
  const hostId = context.hostId;
  if (hostId === null) return;
  const latchStore = useHostServiceWriteLatchStore.getState();
  if (settlement.kind === "refused") {
    // No swap was dispatched, nothing to guard — and nothing to refresh
    // either: a refusal changes neither the coarse marker nor the records.
    latchStore.releaseUpdateInstallAccepted(hostId);
    return;
  }
  if (settlement.kind === "indeterminate") {
    latchStore.releaseUpdateInstallAccepted(hostId);
    invalidateUpdateReads(queryClient, hostId);
    return;
  }
  if (
    settlement.kind === "accepted" &&
    settlement.attemptId !== null &&
    isLiveOverviewIncarnation(context.incarnation)
  ) {
    latchStore.armUpdateDispatch(hostId, {
      attemptId: settlement.attemptId,
      incarnation: context.incarnation,
    });
  }
  invalidateUpdateReads(queryClient, hostId);
}

/**
 * The two reads an accepted install changes: `host.status` for the coarse
 * marker the detached updater publishes, and `host.getInstallationInfo` for
 * the records it leaves behind when it PARKS instead - a stage kept because
 * the host was busy, or an install committed under a host that refused to
 * restart. The second used to wait for its own poll; a Settings click that
 * parks within a second then showed nothing for up to ten.
 */
function invalidateUpdateReads(queryClient: QueryClient, hostId: string): void {
  for (const method of ["host.status", "host.getInstallationInfo"] as const) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, method),
    });
  }
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
