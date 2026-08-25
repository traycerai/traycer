import {
  useCallback,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface InlineTitleFieldProps {
  /** Title as it currently reads; also the value an edit starts from. */
  readonly value: string;
  /** False renders plain text - the caller's kind/permission rules decide. */
  readonly editable: boolean;
  /** Fires only with a non-empty title that differs from `value`. */
  readonly onCommit: (next: string) => void;
  readonly inputLabel: string;
  readonly testId: string;
  /** Typography/truncation of the surrounding title, shared by both states. */
  readonly className: string;
}

/**
 * A title that becomes its own text field in place: tap to edit, commit on blur
 * or Return, cancel on Escape. The title IS the control - it carries no edit
 * affordance of its own and opens no dialog.
 *
 * COMMIT ON BLUR is what makes this safe on a phone. The mobile shell dismisses
 * the soft keyboard by blurring the focused field when a tap lands outside it,
 * so "tap away" ends an edit exactly once, through the same path as any other
 * focus loss, instead of the two recognizers fighting over the gesture.
 *
 * An empty (or whitespace-only) title is never committed: it restores the
 * previous one, the same guard the row rename dialogs express as a disabled
 * Save button.
 */
export function InlineTitleField(props: InlineTitleFieldProps): ReactNode {
  const { value, editable, onCommit, inputLabel, testId, className } = props;
  // `null` means "not editing"; a string is the in-flight draft, which owns the
  // displayed text until the edit ends (so a projection update mid-edit cannot
  // yank the characters out from under the caret).
  const [draft, setDraft] = useState<string | null>(null);
  // Return and Escape both settle the edit and then drop focus; without this the
  // blur they cause would run the commit path a second time.
  const settledRef = useRef(false);

  const focusOnMount = useCallback((node: HTMLInputElement | null) => {
    if (node === null) return;
    node.focus();
    node.select();
  }, []);

  const commit = (raw: string): void => {
    setDraft(null);
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === value) return;
    onCommit(trimmed);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    if (settledRef.current) {
      settledRef.current = false;
      return;
    }
    commit(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      settledRef.current = true;
      commit(event.currentTarget.value);
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      // Kept off the surrounding surfaces: Escape here abandons the edit, it
      // does not close the sheet or the epic tab behind it.
      event.preventDefault();
      event.stopPropagation();
      settledRef.current = true;
      setDraft(null);
      event.currentTarget.blur();
    }
  };

  if (draft !== null) {
    return (
      <input
        type="text"
        value={draft}
        // Mounting the input IS entering the edit, so focus follows it in and
        // the whole title starts selected - typing replaces, as in any rename.
        ref={focusOnMount}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        aria-label={inputLabel}
        data-testid={`${testId}-input`}
        // No padding in either state, so entering an edit swaps the control
        // without shifting the text sideways. `self-stretch` takes the tap
        // target (and the field box) up to the full height of the row the title
        // sits in, which is where the touch-target size comes from.
        className={cn(
          className,
          "self-stretch rounded-sm border-0 bg-transparent outline-hidden ring-1 ring-ring/60",
        )}
      />
    );
  }

  if (!editable) {
    return (
      <span className={className} data-testid={testId}>
        {value}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setDraft(value)}
      data-testid={testId}
      className={cn(
        className,
        "cursor-text self-stretch rounded-sm text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
      )}
    >
      {value}
    </button>
  );
}
