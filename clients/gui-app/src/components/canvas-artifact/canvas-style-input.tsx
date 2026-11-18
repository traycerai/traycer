import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCanvasEditDraft } from "./use-canvas-edit-draft";

export function CanvasStyleInput({
  label,
  value,
  disabled,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => Promise<boolean>;
}) {
  const id = useId();
  const draft = useCanvasEditDraft(value);
  const timer = useRef<number | null>(null);
  const currentCommit = useRef<(next: string) => void>(() => undefined);
  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const commit = async (next: string): Promise<void> => {
    cancel();
    const submission = draft.submit(next);
    if (submission === null) return;
    try {
      if (!(await onCommit(next))) draft.reject(submission);
    } catch {
      draft.reject(submission);
    }
  };
  useLayoutEffect(() => {
    currentCommit.current = (next) => {
      // Refreshes can rebase the draft while its original timer keeps running.
      // Commit through the latest callback, and discard a superseded draft.
      if (next === draft.value) void commit(next);
    };
  });
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        size="sm"
        value={draft.value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          draft.change(next);
          cancel();
          timer.current = window.setTimeout(
            () => currentCommit.current(next),
            450,
          );
        }}
        onBlur={(event) => {
          void commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit(event.currentTarget.value);
          }
          if (event.key === "Escape") {
            cancel();
            draft.reset();
          }
        }}
      />
    </div>
  );
}
