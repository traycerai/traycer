import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { reopenEnvironmentArms } from "@/hooks/environment/use-environment-arms";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";

/** Shown when the person may not attach the task to the team. */
export const ATTACH_ENVIRONMENT_REFUSED_COPY =
  "Ask the task's owner to continue it on a team host.";

/** Shown when no host of the person's own is connected to send it from. */
export const ATTACH_ENVIRONMENT_NEEDS_OWN_HOST_COPY =
  "Open this task on your own computer to continue it on a team host.";

/** The refusal when no host of the person's own can send the attachment. */
export function toastAttachEnvironmentNeedsOwnHost(): void {
  toast.error(ATTACH_ENVIRONMENT_NEEDS_OWN_HOST_COPY);
}

/** A host that predates `epic.attachEnvironment` answers this for it alone. */
export function isAttachEnvironmentUnsupported(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/**
 * `epic.attachEnvironment` on the person's own host: attaches the task to a
 * team so that team's hosts may serve it, before a chat continues on one of
 * them. Unsupported is left to the caller, which continues as before.
 */
export function useEpicAttachEnvironment(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostMutation({
    client,
    method: "epic.attachEnvironment",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.attachEnvironment(),
      // The team's arms for this task, refused while it was not attached,
      // answer now.
      onSuccess: (_response, variables) => {
        reopenEnvironmentArms(variables.teamId, variables.epicId);
      },
      onError: (error) => {
        if (isAttachEnvironmentUnsupported(error)) return;
        if (error.code === "FORBIDDEN") {
          toast.error(ATTACH_ENVIRONMENT_REFUSED_COPY);
          return;
        }
        toastFromHostError(error, "Couldn't continue on the team host.");
      },
    },
  });
}
