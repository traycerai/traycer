import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { appLogger } from "@/lib/logger";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { toast } from "sonner";
import { useStore } from "zustand";

interface CommandMutationCallbacks<Response, Variables> {
  readonly onSuccess?: (response: Response, variables: Variables) => void;
  readonly onError?: (error: Error, variables: Variables) => void;
}

async function enqueueAndWait(
  handle: OpenEpicStoreHandle,
  intent: EpicWriteCommandIntent,
): Promise<CommandRecord<EpicWriteCommandIntent>> {
  const state = handle.store.getState();
  // Await: a Promise is truthy, so skipping await would treat a refused write as an id.
  const commandId = await state.enqueueWriteCommand(intent);
  if (commandId === null) {
    throw new Error("The write was refused by the current epic projection");
  }
  const command = await state.waitForWriteCommand(commandId);
  if (command.state === "committed") return command;
  if (command.resolution?.kind === "rejected") {
    throw new Error(command.resolution.reason);
  }
  throw new Error("A newer authoritative change superseded this write");
}

/** Mutations address the epic session host, never the app-wide one. Null client is refused, not redirected. */

export function useEpicCreateArtifact() {
  const client = useEpicSessionHostClient();
  return useHostMutation({
    client,
    method: "epic.createArtifact",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (_data, variables) => {
        Analytics.getInstance().track(AnalyticsEvent.ArtifactCreated, {
          kind: variables.artifactType,
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't create artifact.");
      },
    },
  });
}

export function useEpicDeleteArtifact(artifactId: string | null) {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "delete-artifact" &&
        command.intent.artifactId === artifactId,
    ),
  );
  interface Variables {
    readonly epicId: string;
    readonly artifactId: string;
  }
  interface Response {
    readonly deleted: boolean;
  }
  const mutateAsync = async (variables: Variables): Promise<Response> => {
    try {
      await enqueueAndWait(handle, {
        kind: "delete-artifact",
        artifactId: variables.artifactId,
      });
      Analytics.getInstance().track(AnalyticsEvent.ArtifactDeleted, null);
      return { deleted: true };
    } catch (error: unknown) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      toast.error("Couldn't delete artifact.", {
        description: normalized.message,
      });
      throw normalized;
    }
  };
  function mutate(variables: Variables): void;
  function mutate(
    variables: Variables,
    callbacks: CommandMutationCallbacks<Response, Variables>,
  ): void;
  function mutate(
    variables: Variables,
    ...callbackList: CommandMutationCallbacks<Response, Variables>[]
  ): void {
    const callbacks = callbackList.length > 0 ? callbackList[0] : undefined;
    // The trailing `.catch` covers the CALLBACKS, not the mutation.
    // Both arms call into caller-supplied `onSuccess` / `onError`, and a throw from either rejects the promise `.then` returns - which `void` then discards.
    void mutateAsync(variables)
      .then(
        (response) => callbacks?.onSuccess?.(response, variables),
        (error: Error) => callbacks?.onError?.(error, variables),
      )
      .catch((error: unknown) => {
        appLogger.warn("epic node mutation callback threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return { mutate, mutateAsync, isPending };
}

export function useEpicUpdateArtifactStatus(artifactId: string | null) {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "update-artifact-status" &&
        command.intent.artifactId === artifactId,
    ),
  );
  interface Variables {
    readonly epicId: string;
    readonly artifactId: string;
    readonly artifactType: "ticket" | "story";
    readonly status: 0 | 1 | 2;
  }
  interface Response {
    readonly updated: boolean;
  }
  const mutateAsync = async (variables: Variables): Promise<Response> => {
    try {
      await enqueueAndWait(handle, {
        kind: "update-artifact-status",
        artifactId: variables.artifactId,
        artifactType: variables.artifactType,
        status: variables.status,
      });
      Analytics.getInstance().track(AnalyticsEvent.ArtifactStatusChanged, {
        kind: variables.artifactType,
        status: analyticsTicketStatus(variables.status),
      });
      return { updated: true };
    } catch (error: unknown) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      toast.error("Couldn't update status.", {
        description: normalized.message,
      });
      throw normalized;
    }
  };
  const mutate = (variables: Variables): void => {
    // `mutateAsync` toasts then rethrows; swallow here so `mutate` matches TanStack.
    void mutateAsync(variables).then(undefined, () => {});
  };
  return { mutate, mutateAsync, isPending };
}

function analyticsTicketStatus(status: number): 0 | 1 | 2 {
  if (status === 1) return 1;
  if (status === 2) return 2;
  return 0;
}

export function useEpicRenameArtifact(
  artifactId: string | null,
  trackUserIntent: boolean,
) {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "rename-artifact" &&
        command.intent.artifactId === artifactId,
    ),
  );
  interface Variables {
    readonly epicId: string;
    readonly artifactId: string;
    readonly title: string;
  }
  interface Response {
    readonly updated: boolean;
  }
  const mutateAsync = async (variables: Variables): Promise<Response> => {
    try {
      await enqueueAndWait(handle, {
        kind: "rename-artifact",
        artifactId: variables.artifactId,
        title: variables.title,
      });
      if (trackUserIntent) {
        Analytics.getInstance().track(AnalyticsEvent.ArtifactRenamed, null);
      }
      return { updated: true };
    } catch (error: unknown) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      toast.error("Couldn't rename artifact.", {
        description: normalized.message,
      });
      throw normalized;
    }
  };
  const mutate = (variables: Variables): void => {
    // Consumed for the same reason the status wrapper above consumes it: the
    // rename's refusal path is the same `enqueueAndWait` throw, and this
    // surface's callers (the mobile switcher rename) are fire-and-forget.
    void mutateAsync(variables).then(undefined, () => {});
  };
  return { mutate, mutateAsync, isPending };
}
