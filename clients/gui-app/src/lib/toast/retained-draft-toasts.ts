import { toast } from "sonner";

/**
 * The ids of on-screen toasts that hold the only copy of a user's draft.
 *
 * These are the one toast kind with NO lifetime: a `SEND_NOT_RECORDED` notice
 * inlines text nothing else holds any more, so it is minted with an infinite
 * duration and stays until the person dismisses it. That is right within the
 * session that lost the draft and wrong the moment the identity changes - the
 * app-level `<Toaster />` lives outside the auth-dependent tree, so the toast
 * survives sign-out and user-switch and shows the previous account's message to
 * whoever signs in next on a shared desktop.
 *
 * NOT a {@link ToastChannel}: a channel is one stable id with replacement
 * semantics, and these are additive - each lost draft is its own toast and must
 * not replace another one.
 *
 * Deliberately scoped to the identity boundary and nothing else. The other
 * teardown boundaries must NOT dismiss these:
 *
 *  - closing a chat or an epic disposes the session, but the TEXT is still the
 *    user's only copy, and destroying it because they closed a tab is the very
 *    loss this notice exists to prevent;
 *  - a host switch is the same account on another machine, so there is nothing
 *    to protect the draft from.
 *
 * Transient chat notices are not tracked. They carry no draft body and expire
 * on their own timer, so their exposure is already bounded; tracking them would
 * grow this set for no lifetime it does not already have.
 */
const retainedToastIds = new Set<string | number>();

/**
 * Track a retained toast so the identity boundary can take it down. Pair with
 * {@link forgetRetainedDraftToast} on the toast's own dismiss callbacks, or the
 * set grows for the life of the session.
 */
export function rememberRetainedDraftToast(id: string | number): void {
  retainedToastIds.add(id);
}

export function forgetRetainedDraftToast(id: string | number): void {
  retainedToastIds.delete(id);
}

/**
 * Take down every retained draft toast. Snapshotted before iterating because
 * sonner invokes `onDismiss` for a programmatic dismiss too, and that callback
 * mutates this set.
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
