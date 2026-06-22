type FocusCallback = () => void;

interface Entry {
  readonly focus: FocusCallback;
  readonly isActive: boolean;
}

const entries = new Set<Entry>();

export function registerComposerFocus(
  focus: FocusCallback,
  isActive: boolean,
): () => void {
  const entry: Entry = { focus, isActive };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

export function focusActiveComposer(): boolean {
  let fallback: FocusCallback | null = null;
  for (const entry of entries) {
    if (entry.isActive) {
      entry.focus();
      return true;
    }
    fallback = entry.focus;
  }
  if (fallback !== null) {
    fallback();
    return true;
  }
  return false;
}
