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

/**
 * Focuses a composer only when one has explicitly registered as active.
 *
 * Mount-time autofocus must not use `focusActiveComposer`'s inactive fallback:
 * the newly active Tiptap editor registers asynchronously, so a retained split
 * partner may temporarily be the only endpoint in the registry.
 */
export function focusRegisteredActiveComposer(): boolean {
  for (const entry of entries) {
    if (!entry.isActive) continue;
    requestPrimaryFocus(entry.target);
    return true;
  }
  return false;
}
