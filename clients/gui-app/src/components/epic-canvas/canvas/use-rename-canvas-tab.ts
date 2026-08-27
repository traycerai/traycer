import { useCallback } from "react";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicRenameChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicRenameTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Commit handler for inline tab-title editing in the canvas tab strip, for
 * RECORD-BACKED nodes only. Mirrors the sidebar rename path so a tab renamed
 * from its right-click menu stays in lockstep with the same node renamed from
 * the sidebar tree: we stamp an optimistic overlay patch
 * (`beginRenameMutation`) for instant feedback, fire the kind-specific
 * authoritative RPC, and only on its SUCCESS update the tab snapshot
 * (`renameArtifactInTab`) - the snapshot is a PERSISTED fallback that
 * cold/pre-hydration renders read, so writing it speculatively preserved a
 * rejected title across restarts while the live selectors had already rolled
 * back.
 *
 * The overlay replaced a `renameArtifact` doc write here. That write assumed
 * every renameable node lives in the epic Y.Doc, which stopped being true when
 * chats moved off YJS and the terminal-agent doc entries were evicted - it
 * resolved the id through three doc maps and returned false when all three
 * missed, which is precisely a registry-backed row.
 *
 * Plain terminals never reach this handler: they are host sessions (not
 * Y.Doc artifacts) whose titles live on the host, so `TabItem` routes their
 * rename through `useTerminalRenameFor` against the tab's bound host - the
 * mutation's optimistic `terminal.list` patch updates every title surface at
 * once.
 *
 * `viewTabId` is the header (epic) view tab that owns the canvas snapshot;
 * `tab.id` is the content id (chat / artifact), not the per-tab `instanceId`.
 */
export function useRenameCanvasTab(
  epicId: string,
  viewTabId: string,
): (tab: EpicCanvasTileRef, title: string) => void {
  const epicHandle = useOpenEpicHandle();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);
  const renameChat = useEpicRenameChat();
  const renameTerminalAgent = useEpicRenameTuiAgent();
  const renameArtifact = useEpicRenameArtifact(true);

  return useCallback(
    (tab, rawTitle) => {
      const trimmed = rawTitle.trim();
      // No same-title suppression: the optimistic local update can already be
      // ahead of a failed RPC, and resubmitting the visible title is the
      // user's retry path. A duplicate rename RPC is harmless (HEAD behavior);
      // the event only fires on authoritative mutation success.
      if (trimmed.length === 0) return;
      if (tab.type === "terminal") return;
      const id = tab.id;
      // DOC-RESIDENT terminal agents keep the direct doc write: an agent
      // whose title still lives in the epic Y.Doc (bound to an un-upgraded
      // peer host) has no registry row on the serving host, so
      // `epic.renameTuiAgent` refuses it (`E_AGENT_NOT_LOCAL`) and the
      // overlay would only ever roll back. Same union-carried `docResident`
      // routing fact the reparent commit reads (`isDocOnlyTerminalAgent`),
      // absent-from-union included. The doc write is synchronous authority -
      // no stamp to retire - and the snapshot follows the write's own
      // success.
      if (tab.type === "terminal-agent") {
        const agents = epicHandle.store.getState().tuiAgents.byId;
        if (!Object.hasOwn(agents, id) || agents[id].docResident) {
          if (epicHandle.store.getState().renameArtifact(id, trimmed)) {
            renameArtifactInTab(viewTabId, id, trimmed);
          }
          return;
        }
      }
      // The optimistic overlay, NOT the doc write this used to do. The doc
      // write covered artifacts and doc-backed chats and silently no-opped for
      // every registry-backed row, which post chats-off-YJS is most of the
      // agent family - so a tab rename of one of those had no local feedback
      // at all and merely looked slow.
      const requestId = epicHandle.store
        .getState()
        .beginRenameMutation(id, trimmed);
      // Retire rides the `mutateAsync` PROMISE, never a per-call `onSettled`:
      // TanStack drops mutate-level callbacks when the component unmounts
      // before settle, and a second `mutate()` on the same observer replaces
      // the first call's callbacks outright - either way the stamp would
      // survive forever, pinning the projector on its full-projection path
      // and inflating the pending count Phase 4.4 reads for dirty/quit. The
      // promise settles regardless of both. The hook-level toasts still fire
      // from the mutation hooks themselves.
      //
      // TanStack settles the promise only after retries are exhausted, so a
      // mid-retry flap is not possible. "landed" keeps the patch applied
      // until the record refetch actually delivers the new title - the ack
      // is proof the host has it - so a successful rename never snaps back
      // to the stale row while the refetch is in flight.
      const retire = (outcome: "landed" | "failed"): void => {
        if (requestId === null) return;
        epicHandle.store.getState().retirePendingMutation(requestId, outcome);
      };
      const landed = (): void => {
        retire("landed");
        // The tab snapshot only on settlement: it is a persisted fallback, not
        // live feedback (the overlay above is), and it has no rollback path -
        // written before the RPC, a terminal failure would leave the rejected
        // title to resurface from a cold render.
        //
        // And only while this is still the LATEST stamped rename for the
        // node: RPC settles are not ordered, so with two renames in flight
        // the older success arm can run after the newer one already wrote -
        // its captured title would overwrite the newer snapshot and
        // resurface on the next cold render. The guard reads the stamp
        // TOMBSTONE, not the live chain, so a successful rename whose own
        // echo swept its chain before the ack still writes.
        if (
          requestId !== null &&
          !epicHandle.store.getState().isLatestRenameStamp(id, requestId)
        ) {
          return;
        }
        renameArtifactInTab(viewTabId, id, trimmed);
      };
      const failed = (): void => {
        retire("failed");
      };
      if (tab.type === "chat") {
        void renameChat
          .mutateAsync({ epicId, chatId: id, title: trimmed })
          .then(landed, failed);
      } else if (tab.type === "terminal-agent") {
        void renameTerminalAgent
          .mutateAsync({ epicId, tuiAgentId: id, title: trimmed })
          .then(landed, failed);
      } else {
        void renameArtifact
          .mutateAsync({ epicId, artifactId: id, title: trimmed })
          .then(landed, failed);
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
}
