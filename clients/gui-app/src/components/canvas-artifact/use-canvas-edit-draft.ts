import { useRef, useState } from "react";

interface SubmittedDraft {
  readonly id: number;
  readonly value: string;
}

interface CanvasEditDraft {
  readonly source: string;
  readonly value: string;
  readonly submitted: readonly SubmittedDraft[];
}

function refreshDraft(draft: CanvasEditDraft, source: string): CanvasEditDraft {
  // A capture can include several queued writes. Match its value when possible;
  // otherwise the oldest submission may have been normalised by computed CSS.
  const match = draft.submitted.findIndex((item) => item.value === source);
  const acknowledged = Math.max(0, match);
  const submitted = draft.submitted.at(acknowledged);
  return {
    source,
    value:
      submitted !== undefined && draft.value !== submitted.value
        ? draft.value
        : source,
    submitted: draft.submitted.slice(acknowledged + 1),
  };
}

/** Keep newer typing while a served value acknowledges an earlier submission. */
export function useCanvasEditDraft(source: string) {
  const [draft, setDraft] = useState<CanvasEditDraft>({
    source,
    value: source,
    submitted: [],
  });
  const nextId = useRef(0);
  let current = draft;
  if (draft.source !== source) {
    current = refreshDraft(draft, source);
    setDraft(current);
  }

  return {
    value: current.value,
    change: (value: string): void =>
      setDraft((previous) => ({ ...previous, value })),
    reset: (): void =>
      setDraft((previous) => ({
        ...previous,
        value: previous.submitted.at(-1)?.value ?? previous.source,
      })),
    submit: (value: string): number | null => {
      const baseline = current.submitted.at(-1)?.value ?? current.source;
      if (value === baseline) return null;
      const submitted = { id: ++nextId.current, value };
      setDraft((previous) => ({
        ...previous,
        submitted: [...previous.submitted, submitted],
      }));
      return submitted.id;
    },
    reject: (id: number): void =>
      setDraft((previous) => ({
        ...previous,
        submitted: previous.submitted.filter((item) => item.id !== id),
      })),
  };
}
