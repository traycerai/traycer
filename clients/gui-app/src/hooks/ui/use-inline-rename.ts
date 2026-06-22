import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";

export interface InlineRenameInputProps {
  readonly ref: RefObject<HTMLInputElement | null>;
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onBlur: () => void;
  readonly onClick: (event: MouseEvent<HTMLInputElement>) => void;
  readonly onDoubleClick: (event: MouseEvent<HTMLInputElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLInputElement>) => void;
  readonly onContextMenu: (event: MouseEvent<HTMLInputElement>) => void;
}

export interface InlineRename {
  readonly isEditing: boolean;
  readonly startEditing: () => void;
  readonly inputProps: InlineRenameInputProps;
}

/**
 * Shared inline "edit this label" state machine for the header and canvas tab
 * strips (and anywhere a label turns into an in-place `<input>`). The caller
 * owns the input's presentation (className / aria / testid) and spreads
 * `inputProps` onto it.
 *
 * Two behaviours matter and are easy to get wrong when hand-rolled per call
 * site:
 *
 * - **Focus.** The edit is started from a context menu; focusing in a
 *   `setTimeout` races the menu's focus-restore. We focus after mount, then
 *   again on the next animation frame after the menu focus scope has finished
 *   closing. The menu must also set
 *   `onCloseAutoFocus={(e) => e.preventDefault()}` so Radix does not pull focus
 *   back to the trigger and instantly blur-commit the input.
 * - **Idempotency.** Enter / Escape and the input's `blur` can both try to
 *   settle the same edit. `settledRef` guarantees commit/cancel runs at most
 *   once per session, so a blur delivered while the input unmounts can't fire a
 *   second (stale) commit.
 *
 * `onCommit` receives the trimmed value and is called only when it is non-empty
 * and actually changed; pass a stable (memoised) callback to keep `inputProps`
 * referentially stable.
 */
export function useInlineRename(args: {
  readonly value: string;
  readonly canEdit: boolean;
  readonly onCommit: (next: string) => void;
}): InlineRename {
  const { value, canEdit, onCommit } = args;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(true);

  useLayoutEffect(() => {
    if (!isEditing) return;
    const focusInput = () => {
      const input = inputRef.current;
      if (input === null) return;
      input.focus({ preventScroll: true });
      input.select();
    };
    focusInput();
    const frame = window.requestAnimationFrame(focusInput);
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing]);

  const startEditing = useCallback(() => {
    if (!canEdit) return;
    settledRef.current = false;
    setEditValue(value);
    setIsEditing(true);
  }, [canEdit, value]);

  const finish = useCallback(
    (commit: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setIsEditing(false);
      if (!commit) return;
      const trimmed = editValue.trim();
      if (trimmed.length === 0 || trimmed === value) return;
      onCommit(trimmed);
    },
    [editValue, onCommit, value],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    },
    [finish],
  );

  const inputProps = useMemo<InlineRenameInputProps>(
    () => ({
      ref: inputRef,
      value: editValue,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setEditValue(event.target.value),
      onKeyDown: handleKeyDown,
      onBlur: () => finish(true),
      onClick: (event: MouseEvent<HTMLInputElement>) => event.stopPropagation(),
      onDoubleClick: (event: MouseEvent<HTMLInputElement>) =>
        event.stopPropagation(),
      onPointerDown: (event: PointerEvent<HTMLInputElement>) =>
        event.stopPropagation(),
      // Keep the right-click from bubbling to the tab's ContextMenuTrigger, so
      // the input's native cut/copy/paste menu shows instead of the tab menu
      // (opening which would blur-commit the edit).
      onContextMenu: (event: MouseEvent<HTMLInputElement>) =>
        event.stopPropagation(),
    }),
    [editValue, finish, handleKeyDown],
  );

  return { isEditing, startEditing, inputProps };
}
