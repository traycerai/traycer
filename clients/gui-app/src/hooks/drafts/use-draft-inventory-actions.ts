import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useDraftRetract,
  type DraftRetractResult,
} from "@/hooks/drafts/use-draft-retract";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import {
  deleteComposerDraftRow,
  deleteLandingDraftRow,
  deleteNewChatDraftRow,
  openChatDraftRow,
  openNewChatDraftRow,
  type DraftRowDeleteOutcome,
} from "@/lib/drafts/draft-inventory-actions";
import { openLandingDraft } from "@/lib/drafts/open-landing-draft";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

/** How long the Undo action stays on screen (D17). */
const UNDO_TOAST_MS = 6000;

export interface DraftInventoryActions {
  readonly openRow: (row: DraftInventoryRow) => void;
  readonly copyRow: (row: DraftInventoryRow) => void;
  readonly deleteRow: (row: DraftInventoryRow) => void;
}

/**
 * Binds the drafts-list row actions to their React-only halves: navigation,
 * the clipboard, toasts, and - the one that matters - a client for the host
 * that OWNS each row.
 *
 * `hostId` is the SURFACE's host (the control's own), which is what a landing
 * row is deleted or retracted through, exactly as History did it. Chat and
 * new-agent rows are routed through their own `ownerHostId` instead, resolved
 * per row from the runtime binding: `useHostClientForHostId` cannot answer for
 * a host id that only exists once a row is clicked, and `resolveNamedHostClient`
 * is the sanctioned seam for an explicitly named host (it is what that hook
 * calls underneath).
 */
export function useDraftInventoryActions(
  hostId: string | null,
): DraftInventoryActions {
  const navigate = useNavigate();
  const binding = useHostBinding();
  const surfaceClient = useHostClientForHostId(hostId);
  const { retract } = useDraftRetract(surfaceClient);
  const { copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: () => toast.success("Copied"),
    onError: () =>
      toast.error("Could not copy text", {
        description: "Try selecting and copying it manually instead.",
      }),
  });

  const openRow = useCallback(
    (row: DraftInventoryRow) => {
      if (row.kind === "landing") {
        openLandingDraft(navigate, row.id);
        return;
      }
      if (row.kind === "new-chat") {
        openNewChatDraftRow(navigate, row);
        return;
      }
      // No toast on `false`: that is only the unaddressable no-owner row the
      // read model never produces. A chat that has since been deleted still
      // opens, and the tile reports that itself.
      openChatDraftRow(navigate, row);
    },
    [navigate],
  );

  const copyRow = useCallback(
    (row: DraftInventoryRow) => {
      copy(extractPlainTextFromComposerJSONContent(row.content));
    },
    [copy],
  );

  const deleteRow = useCallback(
    (row: DraftInventoryRow) => {
      const outcome = deleteDraftRow(row, {
        surfaceHostId: hostId,
        surfaceClient,
        retract,
        ownerClient:
          row.kind === "landing"
            ? surfaceClient
            : resolveNamedHostClient(binding, row.ownerHostId),
      });
      if (!outcome.deleted) return;
      const undo = outcome.undo;
      if (undo === null) {
        toast("Deleted");
        return;
      }
      toast("Deleted", {
        duration: UNDO_TOAST_MS,
        action: { label: "Undo", onClick: undo },
      });
    },
    [binding, hostId, retract, surfaceClient],
  );

  return useMemo(
    () => ({ openRow, copyRow, deleteRow }),
    [openRow, copyRow, deleteRow],
  );
}

function deleteDraftRow(
  row: DraftInventoryRow,
  context: {
    readonly surfaceHostId: string | null;
    readonly surfaceClient: HostClient<HostRpcRegistry> | null;
    readonly retract: (draftId: string) => Promise<DraftRetractResult>;
    readonly ownerClient: HostClient<HostRpcRegistry> | null;
  },
): DraftRowDeleteOutcome {
  const { surfaceHostId, surfaceClient, retract, ownerClient } = context;
  if (row.kind === "landing") {
    // Re-read the row: the list is a memoised projection, and the routing
    // below turns on ownership fields that must be the store's current ones.
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === row.id);
    if (draft === undefined) return { deleted: false };
    return deleteLandingDraftRow(draft, surfaceHostId, surfaceClient, retract);
  }
  if (row.kind === "chat") {
    return deleteComposerDraftRow(
      {
        chatId: row.chatId,
        draftId: row.id,
        ownerHostId: row.ownerHostId,
        foreign: row.foreign,
      },
      ownerClient,
    );
  }
  return deleteNewChatDraftRow(
    { epicId: row.epicId, draftId: row.id, ownerHostId: row.ownerHostId },
    ownerClient,
  );
}
