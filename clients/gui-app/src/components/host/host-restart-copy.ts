/**
 * Copy shared by the two surfaces that restart a host - the menu/tray flow
 * (`LocalHostRestartFlow`) and Settings → Overview. Both answer the same
 * verdicts through the same dialog, so the words live here rather than being
 * written twice and drifting the moment one is reworded.
 */

/**
 * Shown when this machine's host was replaced while a force offer sat open.
 *
 * The offer states host A's session count over a button that respawns
 * whichever host is local NOW, so a swap underneath it makes the two disagree.
 * Both surfaces refuse rather than dispatch, and say why.
 */
export const HOST_CHANGED_DESCRIPTION =
  "This machine's host was replaced while this dialog was open, so nothing " +
  "was stopped. Restart again to check the new host.";

/**
 * What a `host.restart` busy verdict says, wherever it is put to the user.
 *
 * ONE verdict, one sentence: the host closed session admission, found work in
 * flight, reopened it, and told us the count.
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
