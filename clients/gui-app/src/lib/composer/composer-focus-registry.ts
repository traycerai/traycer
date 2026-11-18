import {
  registerPrimaryFocusEndpoint,
  requestPrimaryFocusIfEligible,
  type PrimaryFocusEndpoint,
  type PrimaryFocusTarget,
} from "@/lib/focus/primary-focus-coordinator";

interface Entry {
  readonly target: PrimaryFocusTarget;
  readonly isActive: boolean;
  readonly isSurfaceFocusedNow: () => boolean;
}

const entries = new Set<Entry>();

/**
 * Joins the composer focus registry.
 *
 * `isActive` is a RENDER-TIME claim, and selection can run while it is one
 * commit stale: a surface that becomes focused restores its focus in a passive
 * effect, which is early enough that a background surface's own re-render (and
 * therefore its re-registration) has not happened yet. `isSurfaceFocusedNow` is
 * the live half of the same question - `usePaneFocusProbe()`, which reads its
 * pane's already-committed `data-pane-focused` attribute - so selection can
 * verify the claim instead of trusting it. Registering an owner that cannot
 * currently hold focus is not an error; being SELECTED while it cannot is,
 * because focusing it pulls the tab it lives in back to the foreground.
 */
export function registerComposerFocus(
  surfaceId: string,
  endpoint: PrimaryFocusEndpoint,
  isActive: boolean,
  isSurfaceFocusedNow: () => boolean,
): () => void {
  const entry: Entry = {
    target: { kind: "composer", surfaceId },
    isActive,
    isSurfaceFocusedNow,
  };
  entries.add(entry);
  const unregister = registerPrimaryFocusEndpoint(entry.target, endpoint);
  return () => {
    entries.delete(entry);
    unregister();
  };
}

/**
 * An entry that claims to be active AND whose surface still holds focus right
 * now. A stale claim is skipped outright rather than demoted to the inactive
 * fallback below: it is not a last-resort candidate, it is an owner that has
 * already lost the surface it was speaking for.
 */
function ownsFocusNow(entry: Entry): boolean {
  return entry.isActive && entry.isSurfaceFocusedNow();
}

export function focusActiveComposer(): boolean {
  let fallback: Entry | null = null;
  for (const entry of entries) {
    if (entry.isActive) {
      if (ownsFocusNow(entry) && requestPrimaryFocusIfEligible(entry.target)) {
        return true;
      }
      continue;
    }
    fallback = entry;
  }
  if (fallback === null) return false;
  return requestPrimaryFocusIfEligible(fallback.target);
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
    if (!ownsFocusNow(entry)) continue;
    if (requestPrimaryFocusIfEligible(entry.target)) return true;
  }
  return false;
}
