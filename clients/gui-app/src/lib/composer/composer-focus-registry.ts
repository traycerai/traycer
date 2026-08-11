import {
  registerPrimaryFocusEndpoint,
  requestPrimaryFocus,
  type PrimaryFocusTarget,
} from "@/lib/focus/primary-focus-coordinator";

type FocusCallback = () => void;
type ContainsActiveElement = (activeElement: Element | null) => boolean;

interface Entry {
  readonly target: PrimaryFocusTarget;
  readonly isActive: boolean;
}

const entries = new Set<Entry>();
let nextSurfaceId = 0;

export function registerComposerFocus(
  focus: FocusCallback,
  isActive: boolean,
  containsActiveElement: ContainsActiveElement,
): () => void {
  nextSurfaceId += 1;
  const entry: Entry = {
    target: { kind: "composer", surfaceId: `composer-${nextSurfaceId}` },
    isActive,
  };
  entries.add(entry);
  const unregister = registerPrimaryFocusEndpoint(entry.target, {
    focus,
    containsActiveElement,
    isEligible: () => true,
  });
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
