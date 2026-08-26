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
  HostUpdateInstallResponse,
} from "@traycer/protocol/host/maintenance/index";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostRestartResponse } from "@traycer/protocol/host/restart/index";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { hostMaintenanceMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { useHostServiceWriteLatchStore } from "@/components/settings/panels/host-service-write-latch-store";
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
    options: { enabled: input.enabled, staleTime: 30_000, poll: true },
  });
}

/**
 * `host.getInstallationInfo` — the install record as the HOST reads it.
 *
 * Answers `{status: "unmanaged"}` for a tree-run host rather than failing, and
 * the difference matters on this page: "no install record" is a legitimate,
 * describable state (someone is running the host from a checkout), not an
 * error, and rendering it as one would put a red box on every dev machine.
 */
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
        }
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
): UseMutationResult<
  HostUpdateInstallResponse,
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
      // Same dispatch-arm / settle-release inversion as the service writes:
      // `accepted` settles before `updateProgress` exists, and that gap must
      // stay locked even if the settle is lost to a host-keyed unmount.
      onMutate: () => {
        const hostId = client?.getActiveHostId() ?? null;
        if (hostId !== null) {
          useHostServiceWriteLatchStore
            .getState()
            .armUpdateInstallAccepted(hostId);
        }
        return { hostId };
      },
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
        if (context.hostId === null) return;
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
        // `already-updating` keeps the latch exactly as `accepted` does:
        // SOMEONE'S swap is running — another window's, a direct CLI
        // caller's — inside the same blind gap before the CLI writes
        // `updateProgress`, which is the precise window the latch covers.
        // Releasing here would re-enable restart and the service verbs
        // against that active swap. The refresh below is how the progress
        // row appears once the CLI reports it, and the panel's release
        // effect (or the bounded timer) unwinds the latch from there.
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
