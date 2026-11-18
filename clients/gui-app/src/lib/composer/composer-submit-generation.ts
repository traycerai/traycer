/**
 * The guard that keeps an ASYNC submit from clearing a draft it did not send.
 *
 * A composer submit used to be one synchronous stack frame: read the document,
 * dispatch it, clear the editor, with nothing able to run in between. Resolving
 * a hash-only image broke that — the bytes may need an IndexedDB read, or an
 * upload to the host's blob tier — and the editor stays EDITABLE across that
 * await. So the user can type another sentence, or attach another browser
 * annotation, in the window between pressing Enter and the send going out.
 *
 * What happened then is the failure this exists to prevent: the arm dispatched
 * the document it had captured, `clearAcceptedDraft` / `cleanupAfterSubmit`
 * wiped the CURRENT one, and the sentence typed during the await was destroyed
 * without ever being sent or shown again. Silent, unrecoverable, and invisible
 * in any test that does not type during the await.
 *
 * The rule is therefore: NEVER CLEAR A DOCUMENT YOU DID NOT SEND. Capture a
 * generation at submit entry, and before any dispatch-and-clear ask whether the
 * draft is still the one that was captured.
 *
 * It is deliberately ONE mechanism shared by every async arm rather than a
 * check written per arm. There are four of them now across two files — the chat
 * composer's by-hash upload and its cold-read inline, and the new-conversation
 * modal's two of the same — they were added by different tickets at different
 * times, and a guard whose shape varies per arm is one someone adds an arm
 * beside rather than into.
 *
 * WHAT COUNTS AS THE GENERATION is the caller's to name, because the surfaces
 * disagree about what a draft is: the chat composer's `revision` bumps on both
 * document edits and browser-annotation add/remove (the sidecar is work too,
 * and the clear wipes it), while the new-conversation modal has no sidecar and
 * its `revision` is content alone. Both deliberately ignore selection — moving
 * the caret is not work worth cancelling a send over.
 */
export interface ComposerSubmitGeneration {
  /**
   * Whether the draft captured at submit entry is still the one on screen.
   * `false` means the user changed it during the await, so the captured
   * document is stale and clearing would destroy the newer work.
   */
  readonly stillCurrent: () => boolean;
}

export function captureComposerSubmitGeneration(
  readRevision: () => number,
): ComposerSubmitGeneration {
  const capturedAtSubmit = readRevision();
  return { stillCurrent: () => readRevision() === capturedAtSubmit };
}
