import {
  registerPrimaryFocusEndpoint,
  requestPrimaryFocus,
  type PrimaryFocusEndpoint,
  type PrimaryFocusTarget,
} from "@/lib/focus/primary-focus-coordinator";

interface Entry {
  readonly target: PrimaryFocusTarget;
  readonly isActive: boolean;
}

const entries = new Set<Entry>();

export function registerComposerFocus(
  surfaceId: string,
  endpoint: PrimaryFocusEndpoint,
  isActive: boolean,
): () => void {
  const entry: Entry = {
    target: { kind: "composer", surfaceId },
    isActive,
  };
  entries.add(entry);
  const unregister = registerPrimaryFocusEndpoint(entry.target, endpoint);
  return () => {
    entries.delete(entry);
    unregister();
  };
}

export function focusActiveComposer(): boolean {
  let fallback: Entry | null = null;
  for (const entry of entries) {
    if (entry.isActive) {
      requestPrimaryFocus(entry.target);
      return true;
    }
    fallback = entry;
  }
  if (fallback === null) return false;
  requestPrimaryFocus(fallback.target);
  return true;
}
