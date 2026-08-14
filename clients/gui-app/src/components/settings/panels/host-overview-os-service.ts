import { useEffect, useState } from "react";

/** How long a probable register-restart holds the page without other release. */
const REGISTER_RESTART_LATCH_MS = 45_000;
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
import type { HostRpcRegistry } from "@/lib/host";

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
  /** Whether the scope still has a live route; releases the accepted latch. */
  readonly scopeUsable: boolean;
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
  const {
    deregisterAccepted,
    setDeregisterAccepted,
    registerRestartLikely,
    setRegisterRestartLikely,
    externallyManagedRefusal,
    setExternallyManagedRefusal,
  } = useServiceWriteLatches(input.scopeUsable);
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
          if (response.outcome === "externally-managed") {
            setExternallyManagedRefusal(true);
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
            // Probable success mid-restart: keep the section and the page
            // locked (the latch above) until the scope reflects it or the
            // bounded window expires - `isPending` alone drops right now,
            // while launchd is still replacing the host.
            setRegisterRestartLikely(true);
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
          if (response.outcome === "externally-managed") {
            setExternallyManagedRefusal(true);
          }
          if (response.outcome === "accepted") {
            setDeregisterAccepted(true);
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
 * The three latches that keep the section's state honest ACROSS a write's
 * settle, all releasing on a scope-usability FLIP (dropping means the
 * restart/shutdown they guarded is now the page's visible state; coming back
 * means a live, possibly reconfigured process is answering again). Released on
 * a flip rather than left to a remount, because the panel is keyed by host ID
 * - which an unreachable transition does not change - so a latch that waited
 * for a remount would hold the page for the visit.
 *
 * - `deregisterAccepted`: `accepted` is a beginning, not an end - the detached
 *   CLI is still stopping the host after the mutation settles.
 * - `registerRestartLikely`: on macOS a SUCCESSFUL re-registration can sever
 *   the connection mid-call; the moment the mutation errors, `isPending` is
 *   false, releasing the page while launchd is still replacing the host. Also
 *   released by a bounded timer: a reconnect inside the scope machinery's
 *   tolerance would otherwise never flip usability, and launchd's cycle is a
 *   matter of seconds. (Timer-async, so the setState-in-effect rule does not
 *   apply.)
 * - `externallyManagedRefusal`: a host-side `externally-managed` refusal is
 *   STRUCTURAL - the supervisor is configured into the host's environment, so
 *   retrying cannot answer differently, and the status read may never say so
 *   itself: the CLI's externally-managed STATE describes Desktop's
 *   SMAppService, a different owner than the host's env-var supervisor.
 */
function useServiceWriteLatches(scopeUsable: boolean): {
  readonly deregisterAccepted: boolean;
  readonly setDeregisterAccepted: (value: boolean) => void;
  readonly registerRestartLikely: boolean;
  readonly setRegisterRestartLikely: (value: boolean) => void;
  readonly externallyManagedRefusal: boolean;
  readonly setExternallyManagedRefusal: (value: boolean) => void;
} {
  const [deregisterAccepted, setDeregisterAccepted] = useState(false);
  const [registerRestartLikely, setRegisterRestartLikely] = useState(false);
  const [externallyManagedRefusal, setExternallyManagedRefusal] =
    useState(false);
  // The adjust-during-render form rather than an effect: the release must be
  // part of computing THIS render's answer, not a correction one paint later.
  const [prevScopeUsable, setPrevScopeUsable] = useState(scopeUsable);
  if (prevScopeUsable !== scopeUsable) {
    setPrevScopeUsable(scopeUsable);
    if (!scopeUsable && deregisterAccepted) setDeregisterAccepted(false);
    if (registerRestartLikely) setRegisterRestartLikely(false);
    if (externallyManagedRefusal) setExternallyManagedRefusal(false);
  }
  useEffect(() => {
    if (!registerRestartLikely) return;
    const timer = setTimeout(() => {
      setRegisterRestartLikely(false);
    }, REGISTER_RESTART_LATCH_MS);
    return () => clearTimeout(timer);
  }, [registerRestartLikely]);
  return {
    deregisterAccepted,
    setDeregisterAccepted,
    registerRestartLikely,
    setRegisterRestartLikely,
    externallyManagedRefusal,
    setExternallyManagedRefusal,
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
