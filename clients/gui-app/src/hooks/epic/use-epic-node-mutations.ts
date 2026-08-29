import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
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
  const commandId = state.enqueueWriteCommand(intent);
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

/**
 * EVERY MUTATION HERE ADDRESSES THE EPIC SESSION'S HOST, never the app-wide
 * one, because an artifact is a row IN an Epic and the Epic is projected from
 * exactly one machine.
 *
 * These used to resolve `useHostClient()`. That is the ambient effective host,
 * and it and the session host disagree for a bounded but entirely reachable
 * window: `EpicSessionProvider` keeps the previous handle registered and
 * RENDERED while its replacement establishes, and after a re-point that
 * failed. Only the canvas is made inert for that window (`epic-shell.tsx`
 * passes `readOnly` to the tile subtree alone) - the sidebar is hoisted beside
 * it and stays fully interactive. So a Delete clicked on a row projected from
 * host A was sent to host B: at best a not-found failure, at worst a delete
 * applied to whatever B has under that id.
 *
 * Every call site of these four hooks is inside the Epic shell (sidebar tree,
 * artifact tiles, the canvas tab rename), so there is no consumer for which
 * "the surrounding session" is the wrong question - checked rather than
 * assumed.
 *
 * A null client (no surrounding session) is REFUSED by `useHostMutation`
 * rather than silently redirected, which is the difference that matters here:
 * `useHostClientForHostId(null)` would have followed the effective host and
 * reproduced the defect on the exact render where the session is absent.
 */

/**
 * Mutation hook for epic.createArtifact.
 * Pending state is on the affordance; success is silent (the Y.Doc
 * stream delivers the new row); failure shows a toast.
 */
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

/**
 * Mutation hook for epic.deleteArtifact.
 * Caller opens a confirm dialog first; on Delete the button enters
 * pending state; success is silent.
 */
export function useEpicDeleteArtifact() {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "delete-artifact",
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
    const callbacks = callbackList[0];
    void mutateAsync(variables).then(
      (response) => callbacks?.onSuccess?.(response, variables),
      (error: Error) => callbacks?.onError?.(error, variables),
    );
  }
  return { mutate, mutateAsync, isPending };
}

/**
 * Mutation hook for epic.updateArtifactStatus.
 * Only valid for ticket and story artifacts.
 * Pill enters pending state; success is silent.
 */
export function useEpicUpdateArtifactStatus() {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "update-artifact-status",
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
    void mutateAsync(variables);
  };
  return { mutate, mutateAsync, isPending };
}

function analyticsTicketStatus(status: number): 0 | 1 | 2 {
  if (status === 1) return 1;
  if (status === 2) return 2;
  return 0;
}

/**
 * Mutation hook for epic.renameArtifact.
 * Input/title enters pending (read-only) state; success is silent.
 */
export function useEpicRenameArtifact(trackUserIntent: boolean) {
  const handle = useOpenEpicHandle();
  const isPending = useStore(handle.store, (state) =>
    state.writeCommands.some(
      (command) =>
        command.state === "pending" &&
        command.intent.kind === "rename-artifact",
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
    void mutateAsync(variables);
  };
  return { mutate, mutateAsync, isPending };
}
