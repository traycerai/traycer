import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
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
}): OsServiceSectionProps {
  const { hostName } = input;
  const register = useHostServiceRegister(input.client);
  const deregister = useHostServiceDeregister(input.client);
  const ok = input.status?.outcome === "ok" ? input.status : null;

  return {
    hostName,
    description: describeServiceState({
      status: input.status,
      loading: input.loading,
      hostName,
    }),
    manifestLine: ok === null ? null : `${ok.label} · ${ok.manifestPath}`,
    degrade: input.statusDegrade,
    canRegister: input.registerDegrade === null,
    canDeregister: input.deregisterDegrade === null,
    nothingToDeregister: ok?.state === "not-installed",
    registerPending: register.isPending,
    deregisterPending: deregister.isPending,
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
        // user their registration did not take at the exact moment it did.
        onError: (error) =>
          toastFromHostError(
            error,
            `Lost contact with ${hostName} while re-registering — it is probably restarting.`,
          ),
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
          toast.error(
            response.outcome === "cli-unavailable"
              ? `${hostName} has no Traycer CLI to deregister its service with.`
              : `${hostName} couldn't run the deregister command.`,
          );
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't deregister the service."),
      });
    },
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
