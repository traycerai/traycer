import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { epicShareRefusalFromErrorCode } from "@traycer/protocol/host/epic/share-refusal";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { reopenEnvironmentArms } from "@/hooks/environment/use-environment-arms";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useHostClient } from "@/lib/host";
import {
  classifySendRefusal,
  toastFromHostErrorOnFork,
  toastSendRefusal,
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
 * Whether the attachment stopped at the share gate because the task has not
 * reached the cloud: the gate reports this only after reading it local-homed,
 * and the attachment itself was never sent. Any other failure may follow a
 * task that reached the cloud, which another host can serve.
 */
export function isAttachPromotionPending(error: unknown): boolean {
  return (
    error instanceof HostRpcError &&
    epicShareRefusalFromErrorCode(error.code)?.kind === "promotion-pending"
  );
}

/** The modal's message never left its composer, so a line says nothing of it. */
function toastModalSendRefusal(error: HostRpcError): void {
  const refusal = classifySendRefusal(error);
  switch (refusal.kind) {
    case "silent":
      return;
    case "setting-up":
      toastSendRefusal(
        error,
        "This task is still being set up. Send again in a moment.",
      );
      return;
    case "actionable":
      toastSendRefusal(error, refusal.message);
      return;
    case "failed":
      toastSendRefusal(error, "Couldn't send your message.");
      return;
  }
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
 * `surface` is what asked for it: the new-agent modal and the fork dialog
 * tell a refusal here, while `landing` tells its own, once it knows where the
 * message went.
 */
export function useEpicAttachEnvironment(
  client: HostClient<HostRpcRegistry> | null,
  surface: "landing" | "modal" | "fork",
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
        if (surface === "landing" || isAttachEnvironmentUnsupported(error)) {
          return;
        }
        if (error.code === "FORBIDDEN") {
          toast.error(ATTACH_ENVIRONMENT_REFUSED_COPY);
          return;
        }
        if (surface === "fork") {
          toastFromHostErrorOnFork(
            error,
            "Couldn't continue on the team host.",
          );
          return;
        }
        toastModalSendRefusal(error);
      },
    },
  });
}
