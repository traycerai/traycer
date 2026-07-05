import { PencilLine, X } from "lucide-react";

interface MessageEditDraftPillProps {
  readonly active: boolean;
  readonly onCancel: () => void;
}

/**
 * "Editing message" marker shown above the composer editor while the draft is
 * a persisted message loaded for editing (the message-edit sibling of
 * `QueueEditDraftPill`). Submitting replaces that message (trim + resubmit);
 * Cancel ends edit mode and keeps the text as a plain draft.
 */
export function MessageEditDraftPill(props: MessageEditDraftPillProps) {
  if (!props.active) return null;

  return (
    <div
      className="mb-2 inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-ui-xs text-primary"
      data-testid="message-edit-draft-pill"
    >
      <PencilLine className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium">Editing message</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-primary/85 transition-colors hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Cancel message editing"
        onClick={props.onCancel}
      >
        <X className="size-3" aria-hidden />
        <span>Cancel</span>
      </button>
    </div>
  );
}
