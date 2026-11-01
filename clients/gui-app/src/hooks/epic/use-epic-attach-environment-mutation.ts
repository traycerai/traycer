import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { reopenEnvironmentArms } from "@/hooks/environment/use-environment-arms";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useHostClient } from "@/lib/host";
import {
  toastFromHostErrorOnGesture,
  type HostWriteGesture,
} from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

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
 * Attachments use the person's bearer. Prefer the task's serving host when
 * it is personal, otherwise a personal app-wide host; never a team's host.
 */
export function useEpicAttachmentClient(
  servingClient: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> | null {
  const appWideClient = useHostClient();
  const servingHostId = servingClient?.getActiveHostId() ?? null;
  const appWideHostId = appWideClient.getActiveHostId();
  const servingTeamId = useHostOwnerTeamId(servingHostId);
  const appWideTeamId = useHostOwnerTeamId(appWideHostId);
  if (servingHostId !== null && servingTeamId === null) return servingClient;
  return appWideHostId !== null && appWideTeamId === null
    ? appWideClient
    : null;
}

interface EpicAttachmentContext {
  readonly userId: string | null;
}

/**
 * `epic.attachEnvironment` on the person's own host: attaches the task to a
 * team so that team's hosts may serve it, before a chat continues on one of
 * them. Unsupported is left to the caller, which continues as before.
 * `gesture` is the button that asked for it, which a refusal's copy names.
 */
export function useEpicAttachEnvironment(
  client: HostClient<HostRpcRegistry> | null,
  gesture: HostWriteGesture,
) {
  return useHostMutation<
    HostRpcRegistry,
    "epic.attachEnvironment",
    EpicAttachmentContext
  >({
    client,
    method: "epic.attachEnvironment",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.attachEnvironment(),
      onMutate: () => ({
        userId: useAuthStore.getState().profile?.userId ?? null,
      }),
      // The team's arms for this task, refused while it was not attached,
      // answer now.
      onSuccess: (_response, variables, context) => {
        if (
          context.userId !== (useAuthStore.getState().profile?.userId ?? null)
        ) {
          return;
        }
        reopenEnvironmentArms(variables.teamId, variables.epicId);
      },
      onError: (error, _variables, context) => {
        if (
          context?.userId !== (useAuthStore.getState().profile?.userId ?? null)
        ) {
          return;
        }
        if (isAttachEnvironmentUnsupported(error)) return;
        if (error.code === "FORBIDDEN") {
          toast.error(ATTACH_ENVIRONMENT_REFUSED_COPY);
          return;
        }
        toastFromHostErrorOnGesture(
          error,
          "Couldn't continue on the team host.",
          gesture,
        );
      },
    },
  });
}
