import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostDoctorResponse,
  HostGetInstallationInfoResponse,
  HostUpdateCheckResponse,
  HostUpdateInstallResponse,
} from "@traycer/protocol/host/maintenance/index";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostRestartResponse } from "@traycer/protocol/host/restart/index";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { hostMaintenanceMutationKeys, hostQueryKeys } from "@/lib/query-keys";
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
 * Polled, not merely stale-timed. Its `busySessionCount` is what the drain
 * affordance names in "Apply now — ends N sessions" and then destroys, so the
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
 * A mutation for the same reason `host.doctor` is: it spawns a process and
 * reaches the registry, so "Check now" means someone clicked Check now.
 */
export function useHostUpdateCheck(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  HostUpdateCheckResponse,
  HostRpcError,
  void,
  HostOverviewMutationContext
> {
  return useHostMutation<
    HostRpcRegistry,
    "host.update.check",
    HostOverviewMutationContext,
    void
  >({
    client,
    method: "host.update.check",
    mapVariables: () => EMPTY_PARAMS,
    options: {
      mutationKey: hostMaintenanceMutationKeys.updateCheck(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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
        if (response.outcome !== "accepted") return;
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "host.status"),
        });
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
