import { useQueryClient } from "@tanstack/react-query";

import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { appLogger } from "@/lib/logger";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { hostQueryKeys } from "@/lib/query-keys";
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
  // AWAITED: the queue is worker-side now, so it mints the id over the bridge.
  // A `Promise<string | null>` here is TRUTHY, so the `=== null` refusal check
  // below would pass for a refused write and hand a promise to
  // `waitForWriteCommand` as if it were an id.
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
 *
 * ## Why the three command-backed hooks take an `artifactId`
 *
 * `isPending` is a per-AFFORDANCE flag - every consumer feeds it to one row's
 * `disabled` and one row's spinner (`ticket-tile`, `story-tile`,
 * `switcher-row-actions`, `epic-sidebar-artifact-tree`). Matching on the
 * command KIND alone made it epic-wide: one artifact's in-flight status change
 * disabled and spun every status pill in the epic, and an offline-RETAINED
 * command held all of them for as long as the queue retained it
 * (`command-overlay.ts`). So each hook is told which artifact it speaks for
 * and matches the intent's own `artifactId`, which every artifact-shaped
 * intent already carries.
 *
 * `string | null`, not `string`, because THREE of the nine production callers
 * genuinely speak for no single artifact: the sidebar's bulk-delete controller
 * (`epic-sidebar.tsx`), which dispatches one `mutateAsync` per selected row,
 * and the two rename commit hooks - `useSwitcherRename` and its desktop twin
 * `useRenameCanvasTab` - whose node id arrives as an argument to the returned
 * callback rather than as a value at hook-call time. None of the three reads
 * `isPending`; the bulk dialog has its own `deletePending`. `null` reports
 * `false` rather than "any", so a caller that starts reading it gets an inert
 * flag instead of a resurrected epic-wide one.
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
export function useEpicDeleteArtifact(artifactId: string | null) {
  const handle = useOpenEpicHandle();
  // The delete itself rides the write-command queue, but the tombstone list is
  // a host QUERY (`epic.deletedArtifacts.list`) rather than a projected slice,
  // so a committed command does not refresh it. This is what the scoped-mutation
  // `invalidateMethods` did before the queue took the write over.
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
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
      const hostId = client?.getActiveHostId() ?? null;
      if (hostId !== null) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "epic.deletedArtifacts.list",
          ),
        });
      }
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
    // The trailing `.catch` covers the CALLBACKS, not the mutation. Both arms
    // call into caller-supplied `onSuccess` / `onError`, and a throw from
    // either rejects the promise `.then` returns - which `void` then discards.
    // The two-arm form handles the mutation's own rejection and nothing else.
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

/**
 * Mutation hook for epic.updateArtifactStatus.
 * Only valid for ticket and story artifacts.
 * Pill enters pending state; success is silent.
 */
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
    // CONSUMED, exactly as the delete wrapper above consumes it. `mutateAsync`
    // toasts and then RETHROWS, and a refusal here is ordinary rather than
    // exceptional - `enqueueAndWait` throws on a refused write, a host
    // rejection and a supersede alike - so a bare `void` leaves a rejection
    // nobody handles on every one of them. This is the imitation gap against
    // TanStack's `mutate`, which swallows by design; the toast the AGENTS.md
    // rule mandates already fired inside `mutateAsync`.
    void mutateAsync(variables).then(undefined, () => {});
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
