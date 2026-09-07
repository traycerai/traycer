import { toast } from "sonner";

/** The ids of on-screen toasts that hold the only copy of a user's draft. */
const retainedToastIds = new Set<string | number>();

/**
 * Track a retained toast so the identity boundary can take it down.
 * Pair with {@link forgetRetainedDraftToast} on the toast's own dismiss callbacks, or the set grows for the life of the session.
 */
export function rememberRetainedDraftToast(id: string | number): void {
  retainedToastIds.add(id);
}

export function forgetRetainedDraftToast(id: string | number): void {
  retainedToastIds.delete(id);
}

/**
 * Take down every retained draft toast.
 * Snapshotted before iterating because sonner invokes `onDismiss` for a programmatic dismiss too, and that callback mutates this set.
 */
export function dismissRetainedDraftToasts(): void {
  const ids = [...retainedToastIds];
  retainedToastIds.clear();
  for (const id of ids) toast.dismiss(id);
}

/** Test seam: the boundary is module-level, so it outlives a test otherwise. */
export function resetRetainedDraftToastsForTests(): void {
  retainedToastIds.clear();
}

/** Test seam: what is currently tracked. */
export function retainedDraftToastCountForTests(): number {
  return retainedToastIds.size;
}
