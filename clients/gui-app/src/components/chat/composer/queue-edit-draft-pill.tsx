import { PencilLine, X } from "lucide-react";

/** Beside the pill while a save-and-steer would only save: the edit changes folders. */
export const QUEUE_EDIT_STEER_OFF_NOTE = "Can't steer: folders changed";

interface QueueEditDraftPillProps {
  readonly editingQueueItemId: string | null;
  readonly onCancel: (() => void) | null;
  /** One line beside the pill, or `null` for none. */
  readonly note: string | null;
}

export function QueueEditDraftPill(props: QueueEditDraftPillProps) {
  if (props.editingQueueItemId === null || props.onCancel === null) {
    return null;
  }

  const pill = (
    <div
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-ui-xs text-foreground"
      data-queue-item-id={props.editingQueueItemId}
      data-testid="queue-edit-draft-pill"
    >
      <PencilLine className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate font-medium">Editing</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Cancel queued message editing"
        onClick={props.onCancel}
      >
        <X className="size-3" aria-hidden />
        <span>Cancel</span>
      </button>
    </div>
  );
  if (props.note === null) return pill;
  return (
    <div className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      {pill}
      <span
        className="min-w-0 text-ui-xs text-muted-foreground"
        data-testid="queue-edit-draft-note"
      >
        {props.note}
      </span>
    </div>
  );
}
