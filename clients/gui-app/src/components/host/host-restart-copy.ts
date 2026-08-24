import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";

/**
 * Copy shared by the two surfaces that restart a host - the menu/tray flow
 * (`LocalHostRestartFlow`) and Settings → Overview. Both answer the same
 * verdicts through the same dialog, so the words live here rather than being
 * written twice and drifting the moment one is reworded.
 *
 * Every GUI rendering of a host busy-breakdown also lives here: the identity
 * chip, the re-register confirm, and the drain-gate force. "Sessions" is only
 * a fallback for a host that did not send a typed split.
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

export interface DescribeHostBusyInput {
  readonly breakdown: HostBusyBreakdown | null;
  readonly busySessionCount: number | null;
  readonly busy: boolean;
}

export interface HostBusyCopy {
  /**
   * Chip label, or `null` when the host has not said enough to claim
   * anything — the caller renders nothing / the hedged sentence.
   */
  readonly label: string | null;
  /**
   * Confirm-dialog sentence naming what re-registering would end, or `null`
   * for the same no-claim case.
   */
  readonly sentence: string | null;
}

interface BusySubject {
  readonly phrase: string;
  readonly plural: boolean;
}

/**
 * One helper for every surface that names what is keeping a host busy.
 *
 * Priority, matching the protocol's "null means did not say":
 *
 *   1. a typed breakdown with work → "2 agents · 1 terminal working"
 *   2. a typed all-zero breakdown is Idle only when `busy === false`.
 *      `busy && all-zero` is the in-flight create window (`pendingCreates`
 *      is not a breakdown field) → generic "Busy", never Idle.
 *   3. no breakdown, a positive count → "2 sessions" (@1.1 hosts)
 *   4. no breakdown, `busy` → "Busy" (old host that named no count)
 *   5. no breakdown, a reported zero → "Idle"
 *   6. otherwise → no claim
 */
export function describeHostBusy(input: DescribeHostBusyInput): HostBusyCopy {
  const { breakdown, busySessionCount, busy } = input;
  if (breakdown !== null) {
    const subjects = breakdownSubjects(breakdown);
    if (subjects.length === 0) {
      return busy ? unknownBusyCopy() : idleCopy();
    }
    return namedCopy(subjects);
  }
  if (busySessionCount !== null && busySessionCount > 0) {
    return countFallbackCopy(busySessionCount);
  }
  if (busy) return unknownBusyCopy();
  if (busySessionCount === 0) return idleCopy();
  return { label: null, sentence: null };
}

/**
 * And-joined noun phrase for drain-gate copy ("2 agents and 1 terminal"),
 * or `null` when the breakdown names no work.
 */
export function busyWorkPhrase(breakdown: HostBusyBreakdown): string | null {
  const subjects = breakdownSubjects(breakdown);
  if (subjects.length === 0) return null;
  return joinSubjectPhrases(subjects);
}

/**
 * One sentence naming what the host said is keeping it busy.
 *
 * Breakdown first: a @1.2 host that split the total must never be narrated
 * as "sessions". A @1.1 host (or one whose split is `null`) falls back to
 * the count plus `blockers`, then to "still finishing other work" when
 * nothing is nameable.
 *
 * The verdict still carries two channels that must not be conflated when
 * there is no breakdown: the session count (what the drain projection can
 * count) and the `blockers` breakdown (working agents and live PTYs — the
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
  const fromBreakdown =
    verdict.busyBreakdown === null
      ? []
      : breakdownSubjects(verdict.busyBreakdown);
  if (fromBreakdown.length > 0) {
    return sentenceFromSubjects(fromBreakdown);
  }
  const subjects: BusySubject[] = [];
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
  return sentenceFromSubjects(subjects);
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

function breakdownSubjects(breakdown: HostBusyBreakdown): BusySubject[] {
  const subjects: BusySubject[] = [];
  pushCountSubject(subjects, breakdown.workingAgents, "agent", "agents");
  pushCountSubject(
    subjects,
    breakdown.activeTerminalAgents,
    "terminal agent",
    "terminal agents",
  );
  pushCountSubject(subjects, breakdown.busyTerminals, "terminal", "terminals");
  return subjects;
}

function pushCountSubject(
  subjects: BusySubject[],
  count: number,
  singular: string,
  plural: string,
): void {
  if (count <= 0) return;
  subjects.push({
    phrase: `${count} ${count === 1 ? singular : plural}`,
    plural: count !== 1,
  });
}

function namedCopy(subjects: readonly BusySubject[]): HostBusyCopy {
  const phrase = joinSubjectPhrases(subjects);
  const pronoun = endPronoun(subjects);
  return {
    label: `${subjects.map((subject) => subject.phrase).join(" · ")} working`,
    sentence: `It reports ${phrase}, and re-registering will end ${pronoun}.`,
  };
}

function countFallbackCopy(count: number): HostBusyCopy {
  const phrase = count === 1 ? "1 session" : `${count} sessions`;
  const pronoun = count === 1 ? "it" : "them";
  return {
    label: phrase,
    sentence: `It reports ${phrase}, and re-registering will end ${pronoun}.`,
  };
}

function idleCopy(): HostBusyCopy {
  return {
    label: "Idle",
    sentence: "It reports no work, so nothing should be interrupted.",
  };
}

function unknownBusyCopy(): HostBusyCopy {
  return {
    label: "Busy",
    sentence: "It reports it is busy, and re-registering will end that work.",
  };
}

function sentenceFromSubjects(subjects: readonly BusySubject[]): string {
  const joined = joinSubjectPhrases(subjects);
  const verb = subjects.length > 1 || subjects[0].plural ? "are" : "is";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} ${verb} still keeping this host busy.`;
}

function joinSubjectPhrases(subjects: readonly BusySubject[]): string {
  const phrases = subjects.map((subject) => subject.phrase);
  const last = phrases[phrases.length - 1];
  const leading = phrases.slice(0, -1);
  const serialComma = leading.length > 1 ? "," : "";
  if (leading.length === 0) return last;
  return `${leading.join(", ")}${serialComma} and ${last}`;
}

function endPronoun(subjects: readonly BusySubject[]): "it" | "them" {
  return subjects.length === 1 && !subjects[0].plural ? "it" : "them";
}
