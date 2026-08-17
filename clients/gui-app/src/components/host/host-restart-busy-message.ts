/**
 * What a `host.restart` busy verdict says, wherever it is put to the user.
 *
 * ONE verdict, one sentence: the host closed session admission, found work in
 * flight, reopened it, and told us the count. Both surfaces that answer it -
 * the menu/tray restart flow and Settings → Overview - render it through the
 * SAME force/defer dialog, so the copy is shared rather than written twice.
 * Two copies drifted the moment one was reworded.
 *
 * `forceOffered` is REQUIRED rather than assumed, because the closing sentence
 * promises a control: force is a bridge respawn of THIS machine's host process,
 * so a remote host (or a machine with no CLI bridge) has no route to it and
 * gets the verdict reported with nothing to press. That rule used to live in
 * the Overview's busy banner, which is gone - it survives here so deleting the
 * banner could not quietly take it along.
 */
export function busyRestartMessage(
  busySessionCount: number,
  forceOffered: boolean,
): string {
  const sessions =
    busySessionCount === 1
      ? "1 session is"
      : `${busySessionCount} sessions are`;
  const verdict = `${sessions} still working on this host. Nothing was interrupted; try again when they finish.`;
  return forceOffered
    ? `${verdict} Force restart ends them immediately.`
    : verdict;
}
