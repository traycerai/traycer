import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { LayersPlus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useDraftRetract } from "@/hooks/drafts/use-draft-retract";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { openLandingDraftFromHistory } from "@/lib/commands/actions/open-landing-draft-from-history";
import { deleteLandingDraftThroughHost } from "@/lib/drafts/draft-mirror-coordinator";
import {
  listHistoryLandingDrafts,
  type HistoryLandingDraft,
} from "@/lib/history-landing-drafts";
import { cn } from "@/lib/utils";
import { useDraftSurfaceId } from "@/providers/draft-surface-hooks";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

const DRAFTS_PREVIEW_LIMIT = 5;

export function HistoryDraftsList(props: {
  readonly hostId: string | null;
  readonly onBeforeOpen: ((draftId: string) => void) | null;
}): ReactNode {
  const { hostId, onBeforeOpen } = props;
  const drafts = useLandingDraftStore((state) => state.drafts);
  // Non-null only under a start-task tab, where the composer above this list
  // is editing that draft; the history page and modal mount outside any
  // draft surface and list every retained draft.
  const surfaceDraftId = useDraftSurfaceId();
  const items = useMemo(
    () =>
      listHistoryLandingDrafts({
        drafts,
        query: "",
        excludeDraftId: surfaceDraftId,
      }),
    [drafts, surfaceDraftId],
  );
  const navigate = useNavigate();
  const openDraft = useCallback(
    (draftId: string) => {
      onBeforeOpen?.(draftId);
      openLandingDraftFromHistory(navigate, draftId);
    },
    [navigate, onBeforeOpen],
  );
  const [pendingDelete, setPendingDelete] =
    useState<HistoryLandingDraft | null>(null);
  const [expanded, setExpanded] = useState(false);
  const closeDeleteDialog = useCallback(() => {
    setPendingDelete(null);
  }, []);
  // A delete is routed to the host that owns the row. Ownership never moves:
  // a row another host owns is not deleted through it but RETRACTED - its
  // cloud row removed on the user's authority through this History host -
  // and the owning host tombstones its local row when it finds the cloud
  // row gone. Nothing is shown for any outcome: a retract the cloud
  // confirms (or finds already gone) drops the local mirror, and an
  // inconclusive one - this host offline, or too old for `drafts.retract` -
  // leaves the row where it is for the next attempt rather than hiding a
  // draft that still exists.
  const hostClient = useHostClientForHostId(hostId);
  const { retract } = useDraftRetract(hostClient);
  const confirmDelete = useCallback(() => {
    if (pendingDelete === null) return;
    const draftId = pendingDelete.id;
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === draftId);
    setPendingDelete(null);
    if (draft === undefined) return;
    // With no resolved host there is nowhere to route a delete or a retract,
    // and a local-only delete of a row with a cloud copy would leave that
    // copy to be ingested straight back. Only a row nobody else owns is safe.
    if (hostId === null) {
      if (draft.ownerHostId === null && draft.origin !== "replica") {
        useLandingDraftStore.getState().deleteDraft(draftId);
      }
      return;
    }
    if (draft.origin !== "replica" && draft.ownerHostId === hostId) {
      // A row this host owns is deleted through it explicitly: the landing
      // placement (which `deleteDraft` consults) can point elsewhere while
      // History runs on the app-wide host.
      deleteLandingDraftThroughHost(draftId, hostId, hostClient);
      return;
    }
    if (draft.origin !== "replica" && draft.ownerHostId === null) {
      // A row no host has adopted yet has nowhere to route and retires
      // locally as before.
      useLandingDraftStore.getState().deleteDraft(draftId);
      return;
    }
    void retract(draftId).then((result) => {
      if (result.status !== "retracted" && result.status !== "absent") return;
      // The cloud row is gone; the local mirror goes with it, retired so a
      // directory fetch already in flight cannot ingest it back.
      useLandingDraftStore.getState().applyHostDelete(draftId);
    });
  }, [hostClient, hostId, pendingDelete, retract]);

  if (items.length === 0) return null;

  const visibleItems = expanded ? items : items.slice(0, DRAFTS_PREVIEW_LIMIT);
  const canExpand = items.length > DRAFTS_PREVIEW_LIMIT;

  return (
    <>
      <section
        className="mb-5 border-b border-border/60 pb-5"
        data-testid="history-drafts-block"
        aria-labelledby="history-drafts-heading"
      >
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2
            id="history-drafts-heading"
            className="text-ui-sm font-semibold text-foreground"
          >
            Drafts
          </h2>
          {canExpand ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-ui-xs text-muted-foreground"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((current) => !current);
              }}
            >
              {expanded ? "Show less" : `View all ${items.length}`}
            </Button>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1" data-testid="history-drafts-list">
          {visibleItems.map((item) => (
            <HistoryDraftsRow
              key={item.id}
              item={item}
              onOpen={openDraft}
              onRequestDelete={setPendingDelete}
            />
          ))}
        </ul>
      </section>
      <HistoryDraftsDeleteDialog
        draft={pendingDelete}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
        onConfirm={confirmDelete}
      />
    </>
  );
}

const HistoryDraftsRow = memo(function HistoryDraftsRow(props: {
  readonly item: HistoryLandingDraft;
  readonly onOpen: (draftId: string) => void;
  readonly onRequestDelete: (draft: HistoryLandingDraft) => void;
}): ReactNode {
  const { item } = props;
  const updatedLabel = formatDistanceToNow(item.lastTouchedAt, {
    addSuffix: true,
  });
  return (
    <li
      data-testid="history-drafts-row"
      data-draft-id={item.id}
      className="group/list-row flex items-stretch"
    >
      <div
        className={cn(
          "group relative min-w-0 flex-1 rounded-md transition-colors hover:bg-accent/40",
        )}
      >
        <button
          type="button"
          aria-label={`Open draft ${item.title}`}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            props.onOpen(item.id);
          }}
        />
        <div className="pointer-events-none relative z-10 flex items-center justify-between gap-3 px-3 py-2 pr-11 text-ui-sm">
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <LayersPlus className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <span className="truncate font-medium text-foreground">
                {item.title}
              </span>
              {item.closed ? null : (
                <Badge
                  variant="secondary"
                  data-testid={`history-drafts-open-${item.id}`}
                  className="h-4 px-1 text-overline"
                >
                  Open
                </Badge>
              )}
            </span>
          </span>
          <span className="flex min-w-0 shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
            {item.workspacePath === null ? null : (
              <StartTruncatedText className="max-w-[min(30vw,16rem)]">
                {item.workspacePath}
              </StartTruncatedText>
            )}
            <span className="shrink-0">edited {updatedLabel}</span>
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${item.title}`}
          aria-haspopup="dialog"
          data-testid="history-drafts-row-delete"
          className="pointer-events-auto absolute right-2 top-1/2 z-20 -translate-y-1/2 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onRequestDelete(item);
          }}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
});

function HistoryDraftsDeleteDialog(props: {
  readonly draft: HistoryLandingDraft | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const draft = props.draft;
  const open = draft !== null;
  const title = draft === null ? "" : `Delete "${draft.title}"?`;
  const description =
    draft !== null && !draft.closed
      ? "This draft is currently open. Deleting it removes it here and from every device it has synced to. This cannot be undone."
      : "This permanently removes the start-task draft here and from every device it has synced to. It cannot be undone.";
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[min(92vw,28rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="history-drafts-delete-dialog"
      >
        <div className="flex min-w-0 flex-col gap-1.5 px-5 pt-5 pb-4">
          <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
            {title}
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
            {description}
          </DialogDescription>
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-2 gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => {
              props.onOpenChange(false);
            }}
            data-testid="history-drafts-delete-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full sm:w-auto"
            onClick={props.onConfirm}
            data-testid="history-drafts-delete-confirm"
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
