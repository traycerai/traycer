import { useCallback } from "react";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicRenameChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicRenameTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import { getEpicSessionHandleHostId } from "@/lib/registries/epic-session-registry";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { settleDetachedEpicMutation } from "@/lib/artifacts/detached-epic-mutation";

/**
 * Mirrors the sidebar rename path so a tab renamed from its right-click menu stays in lockstep with the same node renamed from the sidebar tree: we stamp an optimistic overlay patch (`beginRenameMutation`) for instant feedback, fire the kind-specific authoritative RPC, and only on its SUCCESS update the tab snapshot (`renameArtifactInTab`) - the snapshot is a PERSISTED fallback that cold/pre-hydration renders read, so writing it speculatively preserved a rejected title across restarts while the live selectors had already rolled back.
 * Plain terminals never reach this handler: they are host sessions (not Y.Doc artifacts) whose titles live on the host, so `TabItem` routes their rename through `useTerminalRenameFor` against the tab's bound host - the mutation's optimistic `terminal.list` patch updates every title surface at once.
 */
export function useRenameCanvasTab(
  epicId: string,
  viewTabId: string,
): (tab: EpicCanvasTileRef, title: string) => void {
  const epicHandle = useOpenEpicHandle();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);
  const renameChat = useEpicRenameChat();
  const renameTerminalAgent = useEpicRenameTuiAgent();
  // `null`, same reason as the mobile twin: the tab this commits for is an
  // argument to the returned callback, and no caller reads `isPending`.
  const renameArtifact = useEpicRenameArtifact(null, true);

  // ASYNC because the replica moved: the doc write's verdict and the
  // rename-stamp check are both round trips now.
  const commit = useCallback(
    async (tab: EpicCanvasTileRef, rawTitle: string): Promise<void> => {
      const trimmed = rawTitle.trim();
      // A duplicate rename RPC is harmless (HEAD behavior); the event only fires on authoritative mutation success.
      if (trimmed.length === 0) return;
      if (tab.type === "terminal") return;
      const id = tab.id;
      // DOC-RESIDENT terminal agents keep the direct doc write: an agent whose title still lives in the epic Y.Doc (bound to an un-upgraded peer host) has no registry row on the serving host, so `epic.renameTuiAgent` refuses it (`E_AGENT_NOT_LOCAL`) and the overlay would only ever roll back.
      if (tab.type === "terminal-agent") {
        const agents = epicHandle.store.getState().tuiAgents.byId;
        if (!Object.hasOwn(agents, id) || agents[id].docResident) {
          // AWAITED: the replica is on the worker thread now, so the doc write's verdict is a round trip rather than a return value.
          if (await epicHandle.store.getState().renameArtifact(id, trimmed)) {
            renameArtifactInTab(viewTabId, id, trimmed);
          }
          return;
        }
      }
      if (tab.type !== "chat" && tab.type !== "terminal-agent") {
        settleDetachedEpicMutation(
          renameArtifact
            .mutateAsync({ epicId, artifactId: id, title: trimmed })
            .then(
              () => renameArtifactInTab(viewTabId, id, trimmed),
              () => {
                // The resolution cannot tell us which happened: the dead sweep fires both when this rename's echo landed and when a peer overwrote the row, and `metadata-overlay-store.ts` says so in as many words - "chain membership cannot [tell them apart], because the chain is gone in both".
                // If it carries the title we sent, the write landed and the snapshot must follow it; if a peer won with a different title, theirs stands and ours must not be persisted over it; if a peer won with the same title, writing is a no-op.
                const artifacts = epicHandle.store.getState().artifacts.byId;
                if (
                  Object.hasOwn(artifacts, id) &&
                  artifacts[id].title === trimmed
                ) {
                  renameArtifactInTab(viewTabId, id, trimmed);
                }
              },
            ),
          "canvas tab",
          "artifact rename settlement",
        );
        return;
      }
      // Last line for a chat the host's chat store cannot address.
      // A tab title is renamed by inline edit rather than by a menu entry, so there is no affordance to disable here; the sidebar and switcher entries that DO have one are disabled with `CHAT_NOT_ADOPTED_COPY`.
      if (
        resolveChatWriteRoute({
          chatsById: epicHandle.store.getState().chats.byId,
          isChatRow: tab.type === "chat",
          nodeId: id,
          sessionHostId: getEpicSessionHandleHostId(epicHandle),
        }) === "unavailable"
      ) {
        return;
      }
      // The doc write covered artifacts and doc-backed chats and silently no-opped for every registry-backed row, which post chats-off-YJS is most of the agent family - so a tab rename of one of those had no local feedback at all and merely looked slow.
      // Everything below reads `requestId`, so it has to be the value rather than the promise - a `Promise<string>` here is truthy, which would make the `!== null` guards pass and hand a promise to `retirePendingMutation` as if it were an id.
      const requestId = await epicHandle.store
        .getState()
        .beginRenameMutation(id, trimmed);
      // Retire rides the `mutateAsync` PROMISE, never a per-call `onSettled`: TanStack drops mutate-level callbacks when the component unmounts before settle, and a second `mutate()` on the same observer replaces the first call's callbacks outright - either way the stamp would survive forever, pinning the projector on its full-projection path and inflating the pending count Phase 4.4 reads for dirty/quit.
      // TanStack settles the promise only after retries are exhausted, so a mid-retry flap is not possible. "landed" keeps the patch applied until the record refetch actually delivers the new title - the ack is proof the host has it - so a successful rename never snaps back to the stale row while the refetch is in flight.
      const retire = async (outcome: "landed" | "failed"): Promise<void> => {
        if (requestId === null) return;
        await epicHandle.store
          .getState()
          .retirePendingMutation(requestId, outcome);
      };
      const landed = async (): Promise<void> => {
        await retire("landed");
        // The tab snapshot only on settlement: it is a persisted fallback, not live feedback (the overlay above is), and it has no rollback path - written before the RPC, a terminal failure would leave the rejected title to resurface from a cold render.
        // And only while this is still the LATEST stamped rename for the node: RPC settles are not ordered, so with two renames in flight the older success arm can run after the newer one already wrote - its captured title would overwrite the newer snapshot and resurface on the next cold render.
        if (
          requestId !== null &&
          !(await epicHandle.store
            .getState()
            .isLatestRenameStamp(id, requestId))
        ) {
          return;
        }
        renameArtifactInTab(viewTabId, id, trimmed);
      };
      const failed = async (): Promise<void> => {
        await retire("failed");
      };
      // The trailing `.catch` is NOT redundant beside `failed`.
      // `failed` handles the `mutateAsync` rejection only; a throw from inside `landed` or from `failed` itself - `retirePendingMutation` or `isLatestRenameStamp` rejecting after the RPC already succeeded - rejects the promise `.then` returns, which nothing above consumes.
      if (tab.type === "chat") {
        settleDetachedEpicMutation(
          renameChat
            .mutateAsync({ epicId, chatId: id, title: trimmed })
            .then(landed, failed),
          "canvas tab",
          "chat rename settlement",
        );
      } else {
        settleDetachedEpicMutation(
          renameTerminalAgent
            .mutateAsync({ epicId, tuiAgentId: id, title: trimmed })
            .then(landed, failed),
          "canvas tab",
          "terminal-agent rename settlement",
        );
      }
    },
    [
      epicHandle,
      epicId,
      renameArtifact,
      renameArtifactInTab,
      renameChat,
      renameTerminalAgent,
      viewTabId,
    ],
  );

  // The returned callback stays VOID-returning, which is what every caller declares and what a DOM handler needs - so the fire-and-forget has to be made explicit here rather than left as a promise assignable-to-void by accident.
  return useCallback(
    (tab: EpicCanvasTileRef, rawTitle: string): void => {
      settleDetachedEpicMutation(
        commit(tab, rawTitle),
        "canvas tab",
        "rename commit",
      );
    },
    [commit],
  );
}
