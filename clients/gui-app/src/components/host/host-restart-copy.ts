import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";

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
 * One sentence naming what the host said is keeping it busy.
 *
 * The verdict carries two channels that must not be conflated: the session
 * count (lingering + GUI-watched sessions - what the drain projection can
 * count) and the `blockers` breakdown (working agents and live PTYs - the
 * deny signals the count deliberately excludes). A host refusing only for a
 * blocker truthfully reports `busySessionCount: 0`, which is why this
 * sentence can never be built from the count alone: "0 sessions are still
 * working" states a contradiction over a correct refusal.
 *
 * `blockers: null` means the host did not say why (an old host, or one whose
 * work oracles were not composed) - so with a zero count the sentence falls
 * back to naming the host rather than fabricating a subject.
 */
export function busyRestartVerdictSentence(
  verdict: HostRestartBusyVerdict,
): string {
  const subjects: { readonly phrase: string; readonly plural: boolean }[] = [];
  if (verdict.busySessionCount > 0) {
    subjects.push(
      verdict.busySessionCount === 1
        ? { phrase: "1 session", plural: false }
        : { phrase: `${verdict.busySessionCount} sessions`, plural: true },
    );
  }
  if (verdict.blockers?.workingAgents === true) {
    subjects.push({ phrase: "agent work", plural: false });
  }
  if (verdict.blockers?.runningTerminals === true) {
    subjects.push({ phrase: "open terminals", plural: true });
  }
  if (subjects.length === 0) {
    // Busy with nothing nameable: an old host's zero count, an uncomposed
    // oracle, or a claim another actor already holds. Say the host is busy
    // without inventing a subject the host never stated.
    return "The host is still finishing other work.";
  }
  // One subject reads as itself; two join with a bare "and"; three take the
  // serial comma. At most three ever reach here (count, agents, terminals).
  const phrases = subjects.map((subject) => subject.phrase);
  const last = phrases[phrases.length - 1];
  const leading = phrases.slice(0, -1);
  const serialComma = leading.length > 1 ? "," : "";
  let joined = last;
  if (leading.length > 0) {
    joined = `${leading.join(", ")}${serialComma} and ${last}`;
  }
  const verb = subjects.length > 1 || subjects[0].plural ? "are" : "is";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} ${verb} still keeping this host busy.`;
}

/**
 * What a `host.restart` busy verdict says, wherever it is put to the user.
 *
 * ONE verdict, one message: the host closed session admission, found work in
 * flight, reopened it, and told us what it found (see
 * {@link busyRestartVerdictSentence} for the subject rules).
 *
 * `forceOffered` is REQUIRED rather than assumed, because the closing sentence
 * promises a control: force is a bridge respawn of THIS machine's host process,
 * so a remote host (or a machine with no CLI bridge) has no route to it and
 * gets the verdict reported with nothing to press. That rule used to live in
 * the Overview's busy banner, which is gone - it survives here so deleting the
 * banner could not quietly take it along.
 */
export function busyRestartMessage(
  verdict: HostRestartBusyVerdict,
  forceOffered: boolean,
): string {
  const message = `${busyRestartVerdictSentence(verdict)} Nothing was interrupted; try again when the work finishes.`;
  return forceOffered
    ? `${message} Force restart ends it immediately.`
    : message;
}
