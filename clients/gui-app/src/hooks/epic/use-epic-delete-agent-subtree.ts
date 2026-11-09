import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useEpicDeleteChatInBatch } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicDeleteTuiAgentInBatch } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { agentSubtreeDeleteIds } from "@/lib/epic-tree-cascade";
import {
  agentSubtreeDeleteBlockedReason,
  agentSubtreeDeleteTargets,
} from "@/lib/epics/agent-subtree-delete";
import { prepareAgentDelete } from "@/lib/epics/prepare-agent-delete";
import { epicMutationKeys } from "@/lib/query-keys";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";

interface SubtreeDeleteInput {
  readonly nodeId: string;
  readonly confirmedIds: readonly string[];
}

/**
 * Reuse the single-agent mutations and bookkeeping in child-before-parent order.
 * The dialog renders one progress error; members suppress individual error toasts.
 */
export function useEpicDeleteAgentSubtree() {
  const handle = useOpenEpicHandle();
  const sessionHostId = useEpicSessionHostId();
  const deleteChat = useEpicDeleteChatInBatch();
  const deleteTuiAgent = useEpicDeleteTuiAgentInBatch();
  const running = useRef(false);
  const mutation = useMutation<void, Error, SubtreeDeleteInput>({
    mutationKey: epicMutationKeys.deleteAgentSubtree(),
    retry: false,
    mutationFn: async ({ nodeId, confirmedIds }) => {
      const state = handle.store.getState();
      const ids = agentSubtreeDeleteIds(state.tree, nodeId);
      const confirmed = new Set(confirmedIds);
      if (
        ids.length !== confirmed.size ||
        ids.some((id) => !confirmed.has(id))
      ) {
        throw new Error(
          "The nested agents changed. Review the updated count and try again.",
        );
      }
      const blockedReason = agentSubtreeDeleteBlockedReason(
        state,
        handle.epicId,
        ids,
        sessionHostId,
      );
      if (blockedReason !== null) throw new Error(blockedReason);
      const targets = agentSubtreeDeleteTargets(state, ids, sessionHostId);
      let deletedCount = 0;
      for (const target of targets) {
        // A member can start working or lose its route while an earlier delete waits.
        const reason = agentSubtreeDeleteBlockedReason(
          handle.store.getState(),
          handle.epicId,
          ids.slice(deletedCount),
          sessionHostId,
        );
        if (reason !== null) {
          throw new Error(
            `Deleted ${deletedCount} of ${targets.length} agents; stopped at “${target.name}”: ${reason}`,
          );
        }
        const rollback = prepareAgentDelete(handle, target.id, target.kind);
        const progress = `Deleted ${deletedCount} of ${targets.length} agents; stopped at “${target.name}”: `;
        // Results are dependent: never delete a parent after a child's refusal.
        const response = await (
          target.kind === "chat"
            ? deleteChat.mutateAsync({
                epicId: handle.epicId,
                chatId: target.id,
                hostId: target.hostId,
              })
            : deleteTuiAgent.mutateAsync({
                epicId: handle.epicId,
                tuiAgentId: target.id,
                hostId: target.hostId,
              })
        ).catch((error: unknown) => {
          rollback();
          const reason =
            error instanceof Error
              ? error.message
              : "Couldn't confirm deletion.";
          throw new Error(`${progress}${reason}`);
        });
        if (response.outcome === "requested") {
          if (!response.deleted) rollback();
          throw new Error(
            `${progress}Deletion was requested on its host and is not confirmed yet.`,
          );
        }
        if (!response.deleted) {
          rollback();
          throw new Error(`${progress}Deletion was refused.`);
        }
        deletedCount += 1;
      }
    },
  });
  const deleteSubtree = (
    nodeId: string,
    confirmedIds: readonly string[],
  ): Promise<boolean> => {
    if (running.current) return Promise.resolve(false);
    running.current = true;
    return mutation
      .mutateAsync({ nodeId, confirmedIds })
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        running.current = false;
      });
  };
  return { mutation, deleteSubtree };
}
