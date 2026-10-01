import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsDraftAge,
  type AnalyticsDraftInput,
  type AnalyticsDraftKind,
  type AnalyticsDraftSurface,
} from "@/lib/analytics";
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
  /** `usedSearch`: the list's search box held text when the row was opened. */
  readonly openRow: (
    row: DraftInventoryRow,
    input: AnalyticsDraftInput,
    usedSearch: boolean,
  ) => void;
  readonly copyRow: (
    row: DraftInventoryRow,
    input: AnalyticsDraftInput,
  ) => void;
  readonly deleteRow: (
    row: DraftInventoryRow,
    input: AnalyticsDraftInput,
  ) => void;
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
  surface: AnalyticsDraftSurface,
): DraftInventoryActions {
  const navigate = useNavigate();
  const binding = useHostBinding();
  const surfaceClient = useHostClientForHostId(hostId);
  const { copyWith } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: () => toast.success("Copied"),
    onError: () =>
      toast.error("Could not copy text", {
        description: "Try selecting and copying it manually instead.",
      }),
  });

  const openRow = useCallback(
    (
      row: DraftInventoryRow,
      input: AnalyticsDraftInput,
      usedSearch: boolean,
    ) => {
      Analytics.getInstance().track(AnalyticsEvent.DraftOpened, {
        surface,
        draft_kind: draftKind(row),
        input,
        already_open: row.open,
        draft_age: draftAge(row.lastTouchedAt),
        used_search: usedSearch,
      });
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
    [navigate, surface],
  );

  const copyRow = useCallback(
    (row: DraftInventoryRow, input: AnalyticsDraftInput) => {
      const draft_kind = draftKind(row);
      copyWith(() =>
        navigator.clipboard
          .writeText(extractPlainTextFromComposerJSONContent(row.content))
          .then(() => {
            Analytics.getInstance().track(AnalyticsEvent.DraftCopied, {
              surface,
              draft_kind,
              input,
            });
          }),
      );
    },
    [copyWith, surface],
  );

  const deleteRow = useCallback(
    (row: DraftInventoryRow, input: AnalyticsDraftInput) => {
      const outcome = deleteDraftRow(row, {
        surfaceHostId: hostId,
        surfaceClient,
        ownerClient:
          row.kind === "landing"
            ? surfaceClient
            : resolveNamedHostClient(binding, row.ownerHostId),
      });
      if (!outcome.deleted) return;
      const undo = outcome.undo;
      const draft_kind = draftKind(row);
      Analytics.getInstance().track(AnalyticsEvent.DraftDeleted, {
        surface,
        draft_kind,
        input,
        undo_offered: undo !== null,
        draft_age: draftAge(row.lastTouchedAt),
      });
      if (undo === null) {
        toast("Deleted");
        return;
      }
      toast("Deleted", {
        duration: UNDO_TOAST_MS,
        action: {
          label: "Undo",
          onClick: () => {
            if (!undo()) {
              toast("Undo skipped. You typed something new here.");
              return;
            }
            Analytics.getInstance().track(AnalyticsEvent.DraftDeleteUndone, {
              surface,
              draft_kind,
            });
          },
        },
      });
    },
    [binding, hostId, surfaceClient, surface],
  );

  return useMemo(
    () => ({ openRow, copyRow, deleteRow }),
    [openRow, copyRow, deleteRow],
  );
}

function draftKind(row: DraftInventoryRow): AnalyticsDraftKind {
  if (row.kind === "landing") return "start_page";
  return row.kind === "chat" ? "chat" : "new_agent";
}

function draftAge(lastTouchedAt: number): AnalyticsDraftAge {
  const hours = (Date.now() - lastTouchedAt) / 3_600_000;
  if (hours < 1) return "under_1h";
  if (hours < 24) return "1h_24h";
  return hours < 168 ? "1d_7d" : "over_7d";
}

function deleteDraftRow(
  row: DraftInventoryRow,
  context: {
    readonly surfaceHostId: string | null;
    readonly surfaceClient: HostClient<HostRpcRegistry> | null;
    readonly ownerClient: HostClient<HostRpcRegistry> | null;
  },
): DraftRowDeleteOutcome {
  const { surfaceHostId, surfaceClient, ownerClient } = context;
  if (row.kind === "landing") {
    // Re-read the row: the list is a memoised projection, and the routing
    // below turns on ownership fields that must be the store's current ones.
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === row.id);
    if (draft === undefined) return { deleted: false };
    return deleteLandingDraftRow(draft, surfaceHostId, surfaceClient);
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
