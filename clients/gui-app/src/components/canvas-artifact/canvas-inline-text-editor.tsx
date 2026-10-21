import { useLayoutEffect, useRef } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { CanvasSelection } from "./canvas-selection-store";
import { useCanvasEditDraft } from "./use-canvas-edit-draft";
import {
  canvasSelectionIsCurrent,
  useCanvasEditAction,
} from "./use-canvas-edit-action";
import {
  canvasRetypeEdit,
  type CanvasRetypeTarget,
} from "./canvas-inline-text-edit";
import { CanvasInlineTextField } from "./canvas-inline-text-field";
import { CANVAS_SCRIPT_TEXT_NOTE } from "./canvas-text-validation";

export function CanvasInlineTextEditor(props: {
  readonly selection: CanvasSelection;
  readonly target: CanvasRetypeTarget;
  readonly readText: () => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const draft = useCanvasEditDraft(props.target.text);
  const action = useCanvasEditAction(props.selection.artifactId);
  const input = useRef<HTMLTextAreaElement>(null);
  const committing = useRef(false);
  const cancelled = useRef(false);
  const active = useRef(true);
  const isActive = (): boolean => active.current && !cancelled.current;
  const focusInput = (): void => input.current?.focus();
  // A click away unmounts the field; only a still-mounted field can hold a
  // newer draft than the one being committed.
  const hasNewerDraft = (): boolean =>
    input.current !== null && input.current.value !== draft.value;
  useLayoutEffect(() => {
    active.current = true;
    input.current?.focus();
    input.current?.select();
    return () => {
      active.current = false;
    };
  }, []);
  const commit = async (): Promise<void> => {
    if (!isActive() || committing.current) return;
    if (!canvasSelectionIsCurrent(props.selection)) {
      props.onClose();
      return;
    }
    const id = draft.submit(draft.value);
    if (id === null) {
      props.onClose();
      return;
    }
    committing.current = true;
    action.setMessage(null);
    let liveText: string | null;
    try {
      liveText = await props.readText();
    } catch {
      liveText = null;
    }
    committing.current = false;
    // Clicking empty canvas or another element ends editing and clears this
    // selection while the text is read; that is a commit, not a cancel.
    if (cancelled.current) return;
    if (hasNewerDraft()) {
      draft.reject(id);
      return;
    }
    if (liveText === null || liveText !== props.target.text) {
      draft.reject(id);
      action.setMessage(CANVAS_SCRIPT_TEXT_NOTE);
      focusInput();
      return;
    }
    const change = canvasRetypeEdit(props.target, draft.value, props.selection);
    if (change === null) {
      draft.reject(id);
      action.setMessage(
        "This change crosses formatted text. Ask the agent to change it.",
      );
      focusInput();
      return;
    }
    committing.current = true;
    const saved = await action.apply(change.selection, change.edit);
    committing.current = false;
    if (!isActive()) return;
    if (saved) props.onClose();
    else {
      draft.reject(id);
      focusInput();
    }
  };
  return (
    <CanvasInlineTextField
      selection={props.selection}
      value={draft.value}
      disabled={action.pending}
      inputRef={input}
      onChange={draft.change}
      onBlur={() => {
        void commit();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.code === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          props.onClose();
        }
        if (
          event.code === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          void commit();
        }
      }}
    >
      {action.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
      {action.message === null ? null : (
        <p
          role="status"
          className="rounded border bg-popover p-2 text-ui-xs text-destructive"
        >
          {action.message}
        </p>
      )}
    </CanvasInlineTextField>
  );
}
