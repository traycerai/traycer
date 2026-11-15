import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRequestAbortedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type { AttachEnvironmentResponseV20 } from "@traycer/protocol/host/epic/environment-attachment";
import { epicShareRefusalFromErrorCode } from "@traycer/protocol/host/epic/share-refusal";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { reopenEnvironmentArms } from "@/hooks/environment/use-environment-arms";
import {
  hostClientUnavailableError,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useHostBinding, useHostClient } from "@/lib/host";
import { withHostMutationErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
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

const METHOD = "epic.attachEnvironment";

/**
 * One attachment: the task, the team, and the operation on the person's
 * sign-in taken when they pressed send (`AuthService.environmentCloud()`),
 * null with no session service. The cloud attachment is sent after the host
 * has answered, so it must still go out as them: not once that sign-in has
 * ended or been entered again.
 */
export interface EpicAttachment {
  readonly epicId: string;
  readonly teamId: string;
  readonly operation: EnvironmentCloud | null;
}

type AttachmentFailureKind = "unauthorized" | "forbidden" | "refused";

/**
 * The code the host's `@1.0` gave the same answer from the cloud
 * (`cloudErrorFromResponse`): a refused sign-in is `UNAUTHORIZED`, a refused
 * person `FORBIDDEN`, and every other failure, a team with no environment
 * for the person included, a plain `RPC_ERROR`, so each surface reads what
 * it read for the host's call.
 */
const FAILURE_CODE: Readonly<Record<AttachmentFailureKind, RpcErrorCode>> = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  refused: "RPC_ERROR",
};

function attachmentFailure(kind: AttachmentFailureKind): HostRpcError {
  return new HostRpcError({
    code: FAILURE_CODE[kind],
    message: `${METHOD}: the attachment was refused`,
    requestId: "",
    method: METHOD,
    fatalDetails: null,
  });
}

/** Its sign-in ended before it was sent: not sent, and nothing is said. */
function assertOriginSignIn(operation: EnvironmentCloud): void {
  if (operation.onOriginSignIn()) return;
  throw new HostRequestAbortedError({
    message: "The account changed before the attachment was sent",
    requestId: crypto.randomUUID(),
    method: METHOD,
    mayHaveDispatched: false,
  });
}

/**
 * The cloud half, once the host has prepared the task: the team's
 * environment from the person's own list (as the host found it), then the
 * attachment, each sent only while the sign-in the person pressed on is
 * current, and checked before the bearer is read.
 */
async function attachOnSignIn(
  binding: HostRuntimeBinding<HostRpcRegistry>,
  attachment: EpicAttachment,
  operation: EnvironmentCloud,
): Promise<void> {
  assertOriginSignIn(operation);
  const directory = await binding.auth.listEnvironments();
  if (directory.kind !== "ok") {
    throw attachmentFailure(
      directory.kind === "unauthorized" ? "unauthorized" : "refused",
    );
  }
  const environment = directory.list.environments.find(
    (candidate) =>
      candidate.ownerKind === "organization" &&
      candidate.ownerId === attachment.teamId,
  );
  if (environment === undefined) throw attachmentFailure("refused");
  assertOriginSignIn(operation);
  const result = await binding.auth.attachTaskEnvironment({
    taskId: attachment.epicId,
    environmentId: environment.environmentId,
  });
  if (result.kind === "ok") return;
  throw attachmentFailure(
    result.kind === "no_response" ? "refused" : result.kind,
  );
}

/**
 * Attaches the task to a team so that team's hosts may serve it, before a
 * chat continues on one of them: `epic.attachEnvironment@2.0` on the
 * person's own host prepares the task (a local create still on its way to
 * the cloud is waited for, with the host's refusals), then the app attaches
 * it on the person's own sign-in. Unsupported is left to the caller, which
 * continues as before.
 * `surface` is what asked for it: the new-agent modal and the fork dialog
 * tell a refusal here, while `landing` tells its own, once it knows where the
 * message went.
 */
export function useEpicAttachEnvironment(
  client: HostClient<HostRpcRegistry> | null,
  surface: "landing" | "modal" | "fork",
) {
  const binding = useHostBinding();
  return useMutation<
    AttachEnvironmentResponseV20,
    HostRpcError,
    EpicAttachment,
    EpicAttachmentContext
  >({
    ...withHostMutationLifecycleBoundary(METHOD, {
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
    }),
    mutationFn: (attachment) =>
      withHostMutationErrorBoundary(METHOD, async () => {
        if (client === null) throw hostClientUnavailableError(METHOD);
        const prepared = await client.request(METHOD, {
          epicId: attachment.epicId,
        });
        if (binding === null || attachment.operation === null) {
          throw hostClientUnavailableError(METHOD);
        }
        await attachOnSignIn(binding, attachment, attachment.operation);
        return prepared;
      }),
  });
}
