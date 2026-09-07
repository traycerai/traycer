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
 * Focus after mount and again next frame; the menu must preventDefault onCloseAutoFocus. settledRef makes commit/cancel run at most once.
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
