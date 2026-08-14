import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostServiceDeregisterResponse,
  HostServiceRegisterResponse,
  HostServiceStatusResponse,
} from "@traycer/protocol/host/maintenance/index";
import type { OsServiceSectionProps } from "@/components/settings/panels/host-overview-advanced";
import type { OverviewDegradeReason } from "@/components/settings/panels/host-overview-model";
import {
  useHostServiceDeregister,
  useHostServiceRegister,
} from "@/components/settings/panels/host-overview-rpc";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  hostServiceWriteLatches,
  useHostServiceWriteLatchStore,
} from "@/components/settings/panels/host-service-write-latch-store";
import type { HostRpcRegistry } from "@/lib/host";

/** How long a probable register-restart holds the page without other release. */
const REGISTER_RESTART_LATCH_MS = 45_000;
/** How long an accepted deregister holds it - the detached CLI can fail late. */
const DEREGISTER_ACCEPTED_LATCH_MS = 60_000;

/**
 * The `host.service.*` ADAPTER: RPC in, `OsServiceSectionProps` out.
 *
 * The section itself renders and decides nothing about where its answers come
 * from, so this is where the RPC half lives. The recovery console has a sibling
 * adapter over the local CLI bridge, which is the only source that can answer
 * for a machine whose host process is not running — same section, same copy,
 * different question asked.
 */
export function useOverviewOsService(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  readonly status: HostServiceStatusResponse | undefined;
  readonly loading: boolean;
  readonly statusDegrade: OverviewDegradeReason | null;
  readonly registerDegrade: OverviewDegradeReason | null;
  readonly deregisterDegrade: OverviewDegradeReason | null;
  readonly busy: boolean;
  /** The scoped host's id - the latch store's key. `null` disables latching. */
  readonly hostId: string | null;
  /** Whether the scope still has a live route; releases the accepted latch. */
  readonly scopeUsable: boolean;
  /** Refetches `host.service.status`; called when a restart window expires. */
  readonly refetchStatus: () => void;
  /**
   * What the host said about open sessions, `null` while it has not settled -
   * the register CONFIRM names it, because re-registering bootouts the very
   * job running those sessions (macOS) and must not read as a safe repair.
   */
  readonly settledBusySessionCount: number | null;
}): OsServiceSectionProps {
  const { hostName } = input;
  const register = useHostServiceRegister(input.client);
  const deregister = useHostServiceDeregister(input.client);
  const { deregisterAccepted, registerRestartLikely, externallyManagedRefusal } =
    useServiceWriteLatchLifecycle(
      input.hostId,
      input.scopeUsable,
      input.refetchStatus,
    );
  const ok = input.status?.outcome === "ok" ? input.status : null;
  // A registration someone ELSE owns — Desktop's SMAppService, or the external
  // supervisor of a host running with `TRAYCER_HOST_UPDATES=external`. Both
  // verbs are withheld rather than disabled: the CLI either refuses the write
  // or, worse, installs a second unit beside the owner's, so there is no state
  // in which offering them here is honest.
  const externallyManaged = ok?.state === "externally-managed";
  // The status read has affirmatively said there is NO CLI on that machine.
  // Both verbs run that same CLI, so offering them is advertising a
  // deterministic `cli-unavailable` toast. Only the affirmative answer hides
  // them: a failed or unreadable status says nothing about whether the CLI
  // exists, and withdrawing repair verbs on ambiguity would take Re-register
  // away exactly when someone is debugging a flaky host.
  const cliUnavailable = input.status?.outcome === "cli-unavailable";

  return {
    hostName,
    description: describeServiceState({
      status: input.status,
      loading: input.loading,
      hostName,
    }),
    manifestLine: ok === null ? null : `${ok.label} · ${ok.manifestPath}`,
    degrade: input.statusDegrade,
    canRegister:
      input.registerDegrade === null &&
      !externallyManaged &&
      !cliUnavailable &&
      !externallyManagedRefusal,
    canDeregister:
      input.deregisterDegrade === null &&
      !externallyManaged &&
      !cliUnavailable &&
      !externallyManagedRefusal,
    nothingToDeregister: ok?.state === "not-installed",
    registerPending: register.isPending || registerRestartLikely,
    deregisterPending: deregister.isPending || deregisterAccepted,
    settledBusySessionCount: input.settledBusySessionCount,
    busy: input.busy,
    onRegister: () => {
      register.mutate(undefined, {
        onSuccess: (response) => {
          if (response.outcome === "ok") {
            toast.success(`Re-registered ${hostName}'s service`);
            return;
          }
          toast.error(describeServiceRegisterFailure(response, hostName));
        },
        // A dropped connection here is the EXPECTED shape of success on macOS,
        // where registering is a bootout/bootstrap cycle that replaces the very
        // process answering this call. Reporting it as a failure would tell the
        // user their registration did not take at the exact moment it did —
        // which is exactly what handing this to `toastFromHostError` did: its
        // transport branch overrides ANY fallback with a generic "Can't reach
        // the Traycer host" error toast plus a host-error notification. So the
        // expected disconnect is branched on HERE, as information rather than
        // failure; everything else keeps the generic mapping.
        onError: (error) => {
          if (error instanceof HostTransportFailureError) {
            // Probable success mid-restart. The latch was armed at DISPATCH
            // (hook level, host-keyed store) and this settle deliberately
            // does not release it - the page stays locked until the scope
            // reflects the restart or the bounded window expires.
            toast.info(
              `Lost contact with ${hostName} while re-registering — it is probably restarting.`,
            );
            return;
          }
          toastFromHostError(
            error,
            `Couldn't re-register ${hostName}'s service.`,
          );
        },
      });
    },
    onDeregister: () => {
      deregister.mutate(undefined, {
        onSuccess: (response) => {
          if (response.outcome === "accepted") {
            // Deliberately not "Deregistered". The CLI was dispatched detached
            // because it kills this host mid-command; nobody here ever learns
            // whether it finished, and claiming otherwise is the one thing that
            // response shape exists to prevent.
            toast.success(`Stopping ${hostName} and deregistering it`);
            return;
          }
          toast.error(describeServiceDeregisterFailure(response, hostName));
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't deregister the service."),
      });
    },
  };
}

/**
 * The section's view of the host-keyed latch STORE, plus the two lifecycles
 * only a mounted component can run for it: the bounded timers and the
 * scope-flip release. The latches themselves live in
 * `host-service-write-latch-store` and are ARMED at hook level in
 * `host-overview-rpc.ts` (dispatch-armed, settle-released), because both the
 * component state and its settle callbacks die when the host-keyed panel
 * unmounts mid-flight - see the store's doc for the two failure shapes that
 * design closes.
 *
 * Timer windows: a launchd bootout/bootstrap or a detached shutdown is a
 * matter of seconds, so a latch nothing has released within its window is
 * guarding an operation that finished or never happened. Each expiry also
 * refetches `host.service.status`: that query never polls (`poll: null`),
 * never remounts here, and its `enabled` never transitions when the scope
 * absorbed the event - the timer is its one deterministic path back to truth.
 */
function useServiceWriteLatchLifecycle(
  hostId: string | null,
  scopeUsable: boolean,
  refetchStatus: () => void,
): {
  readonly deregisterAccepted: boolean;
  readonly registerRestartLikely: boolean;
  readonly externallyManagedRefusal: boolean;
} {
  const byHost = useHostServiceWriteLatchStore((state) => state.byHost);
  const latches = hostServiceWriteLatches(byHost, hostId);
  const refetchRef = useRef(refetchStatus);
  useEffect(() => {
    refetchRef.current = refetchStatus;
  });
  // Scope-flip release: dropping means the restart/shutdown the latches
  // guarded is now the page's visible state; coming back means a live,
  // possibly reconfigured process is answering again. Store writes are not
  // React setState, so running this in an effect is fine.
  const prevUsableRef = useRef(scopeUsable);
  useEffect(() => {
    if (prevUsableRef.current === scopeUsable) return;
    prevUsableRef.current = scopeUsable;
    if (hostId !== null) {
      useHostServiceWriteLatchStore.getState().releaseAll(hostId);
    }
  }, [scopeUsable, hostId]);
  const { registerRestartLikelyAt, deregisterAcceptedAt } = latches;
  useEffect(() => {
    if (hostId === null || registerRestartLikelyAt === null) return;
    const remaining = Math.max(
      0,
      registerRestartLikelyAt + REGISTER_RESTART_LATCH_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      useHostServiceWriteLatchStore
        .getState()
        .releaseRegisterRestartLikely(hostId);
      refetchRef.current();
    }, remaining);
    return () => clearTimeout(timer);
  }, [hostId, registerRestartLikelyAt]);
  useEffect(() => {
    if (hostId === null || deregisterAcceptedAt === null) return;
    const remaining = Math.max(
      0,
      deregisterAcceptedAt + DEREGISTER_ACCEPTED_LATCH_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      useHostServiceWriteLatchStore
        .getState()
        .releaseDeregisterAccepted(hostId);
      // The host may still be answering (the detached CLI can fail after
      // `accepted`) - show whatever is actually true now.
      refetchRef.current();
    }, remaining);
    return () => clearTimeout(timer);
  }, [hostId, deregisterAcceptedAt]);
  return {
    deregisterAccepted: latches.deregisterAcceptedAt !== null,
    registerRestartLikely: latches.registerRestartLikelyAt !== null,
    externallyManagedRefusal: latches.externallyManagedRefusal,
  };
}

/**
 * What the registration IS, in a sentence, including when the host could not
 * answer.
 *
 * The bridge-era copy had two states, registered and not; over RPC there is a
 * third — asked and refused — and it must not collapse into either. Rendering a
 * failed read as "Not registered" would invite someone to press Re-register
 * against a host whose service is fine and whose CLI is missing.
 */
function describeServiceState(input: {
  readonly status: HostServiceStatusResponse | undefined;
  readonly loading: boolean;
  readonly hostName: string;
}): string {
  if (input.status === undefined) {
    return input.loading
      ? "Checking service registration…"
      : `Couldn't read ${input.hostName}'s service registration.`;
  }
  switch (input.status.outcome) {
    case "ok":
      if (input.status.state === "not-installed") {
        return "Not registered. The OS service manifest is required for the host to survive logout.";
      }
      if (input.status.state === "externally-managed") {
        // The registration EXISTS — this is the normal state of a
        // Desktop-managed machine — it just is not the CLI's to change, so the
        // verbs below are withheld rather than offered-and-refused.
        return "Registered and managed by Traycer Desktop, which owns this host's service registration.";
      }
      return input.status.state === "running"
        ? "Registered and running. The OS service manifest starts the host at user login."
        : "Registered but not running. The OS service manifest starts the host at user login.";
    case "cli-unavailable":
      return `${input.hostName} has no Traycer CLI, so its service registration can't be read from here.`;
    default:
      return `${input.hostName} couldn't read its own service registration.`;
  }
}

function describeServiceRegisterFailure(
  response: Exclude<HostServiceRegisterResponse, { readonly outcome: "ok" }>,
  hostName: string,
): string {
  if (response.outcome === "externally-managed") {
    // The host refused before running the CLI: an external supervisor owns its
    // service lifecycle. Reachable only when the status read that hides the
    // buttons is stale, so this is a correction rather than an error report.
    return `${hostName}'s service is managed by an external supervisor, so it can't be re-registered from here.`;
  }
  if (response.outcome === "cli-unavailable") {
    return `${hostName} has no Traycer CLI to register its service with.`;
  }
  if (response.outcome === "invalid-output") {
    return `${hostName}'s CLI returned something unreadable while registering.`;
  }
  // The CLI's own message, when it left one. This is the whole reason the
  // response carries a string: the refusal that matters most here — a label
  // owned by Traycer Desktop's SMAppService registration — names its own
  // remedy, and "couldn't register" would throw that away.
  return response.message ?? `${hostName} couldn't register its OS service.`;
}

function describeServiceDeregisterFailure(
  response: Exclude<
    HostServiceDeregisterResponse,
    { readonly outcome: "accepted" }
  >,
  hostName: string,
): string {
  switch (response.outcome) {
    case "externally-managed":
      return `${hostName}'s service is managed by an external supervisor, so it can't be deregistered from here.`;
    case "cli-unavailable":
      return `${hostName} has no Traycer CLI to deregister its service with.`;
    case "cli-failed":
      return `${hostName} couldn't run the deregister command.`;
  }
}
