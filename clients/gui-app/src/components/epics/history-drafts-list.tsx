import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { openLandingDraftFromHistory } from "@/lib/commands/actions/open-landing-draft-from-history";
import {
  listHistoryLandingDrafts,
  type HistoryLandingDraft,
} from "@/lib/history-landing-drafts";
import { cn } from "@/lib/utils";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

export function HistoryDraftsList(props: {
  readonly query: string;
  readonly hostId: string | null;
  readonly onBeforeOpen: ((draftId: string) => void) | null;
  readonly listRef: RefObject<HTMLUListElement | null>;
  readonly onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  const { listRef, onRowKeyDown, query, hostId, onBeforeOpen } = props;
  const drafts = useLandingDraftStore((state) => state.drafts);
  const items = useMemo(
    () =>
      listHistoryLandingDrafts({
        drafts,
        query,
        currentHostId: hostId,
      }),
    [drafts, hostId, query],
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
  const closeDeleteDialog = useCallback(() => {
    setPendingDelete(null);
  }, []);
  const confirmDelete = useCallback(() => {
    if (pendingDelete === null) return;
    useLandingDraftStore.getState().deleteDraft(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete]);

  if (items.length === 0 && query.trim().length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
        data-testid="history-drafts-empty"
      >
        <p className="font-medium text-foreground">No start-task drafts</p>
        <p>Closed drafts you have not deleted will show up here.</p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
        data-testid="history-drafts-filtered-empty"
      >
        <p className="font-medium text-foreground">
          No drafts match this search.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul
        ref={listRef}
        className="flex flex-col gap-2"
        data-testid="history-drafts-list"
      >
        {items.map((item) => (
          <HistoryDraftsRow
            key={item.id}
            item={item}
            onOpen={openDraft}
            onRequestDelete={setPendingDelete}
            onRowKeyDown={onRowKeyDown}
          />
        ))}
      </ul>
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
  readonly onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
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
          data-history-row-target=""
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            props.onOpen(item.id);
          }}
          onKeyDown={props.onRowKeyDown}
        />
        <div className="pointer-events-none relative z-10 flex items-center justify-between gap-3 p-3 pr-28 text-ui-sm">
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
          size="sm"
          aria-label={`Open ${item.title}`}
          data-testid="history-drafts-row-open"
          className="pointer-events-auto absolute right-11 top-1/2 z-20 -translate-y-1/2 opacity-0 transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onOpen(item.id);
          }}
        >
          Open
        </Button>
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
      ? "This draft is currently open. Deleting it removes it on every device. This cannot be undone."
      : "This permanently removes the start-task draft on every device. It cannot be undone.";
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
