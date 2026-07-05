import { PencilLine, X } from "lucide-react";

interface EditDraftPillProps {
  /** Pill label, e.g. "Editing" (queue item) or "Editing message". */
  readonly label: string;
  readonly cancelAriaLabel: string;
  readonly onCancel: () => void;
  readonly testId: string;
}

/**
 * Shared "editing a draft" marker rendered above the composer editor. Both the
 * queue-item and message edit modes use it; only the label, the cancel
 * aria-label, and the test id differ. Callers own the visibility guard (each
 * edit mode returns null when inactive) and pass a stable `onCancel`.
 */
export function EditDraftPill(props: EditDraftPillProps) {
  return (
    <div
      className="mb-2 inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-ui-xs text-primary"
      data-testid={props.testId}
    >
      <PencilLine className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium">{props.label}</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-primary/85 transition-colors hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={props.cancelAriaLabel}
        onClick={props.onCancel}
      >
        <X className="size-3" aria-hidden />
        <span>Cancel</span>
      </button>
    </div>
  );
}
