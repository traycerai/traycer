import { useEffect, useId } from "react";
import { setEpicDraftHeld } from "@/lib/epics/epic-draft-guard";

/**
 * Declare, for as long as this component is mounted, whether its editor holds
 * user-typed text that a remount would not restore - which is what stops a
 * park from unmounting the text out of existence (see `epic-draft-guard.ts`).
 *
 * `held` is the caller's own answer, and the question it answers is narrower
 * than "is the editor non-empty":
 *
 *  - a BLANK composer holds text as soon as it is non-empty, because a
 *    remount gives it back empty;
 *  - an EDIT composer opened on existing content holds nothing until the user
 *    changes it, because a remount gives that content back verbatim;
 *  - an editor the user emptied holds no TEXT, whatever it started with, so
 *    it does not veto - the original is still on the saved comment.
 *
 * The registration is keyed by `useId()`, not by anything the caller passes:
 * two composers of one epic are two holders, and a `draftId` derived from an
 * epic or a thread would let one composer's cleanup withdraw another's claim
 * - the stale-holder failure in reverse, and just as silent.
 *
 * `setEpicDraftHeld` is called on EVERY run rather than only when `held` is
 * true, so the pair is always register-then-cleanup with no arm that skips
 * the write. Withdrawing a claim that was never made is a no-op.
 */
export function useEpicDraftGuard(epicId: string, held: boolean): void {
  const draftId = useId();
  useEffect(() => {
    setEpicDraftHeld(epicId, draftId, held);
    return () => {
      setEpicDraftHeld(epicId, draftId, false);
    };
  }, [draftId, epicId, held]);
}
