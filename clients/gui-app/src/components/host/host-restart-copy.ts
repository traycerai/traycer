import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";

/** Both answer the same verdicts through the same dialog, so the words live here rather than being written
 * twice and drifting the moment one is reworded. */

/** Shown when this machine's host was replaced while a force offer sat open. Both surfaces refuse rather than
 * dispatch, and say why. */
export const HOST_CHANGED_DESCRIPTION =
  "This machine's host was replaced while this dialog was open, so nothing " +
  "was stopped. Restart again to check the new host.";

export interface DescribeHostBusyInput {
  readonly breakdown: HostBusyBreakdown | null;
  readonly busySessionCount: number | null;
  readonly busy: boolean;
}

export interface HostBusyCopy {
  /** Chip label, or `null` when the host has not said enough to claim anything - the caller renders nothing / the
   * hedged sentence. */
  readonly label: string | null;
  /** Confirm-dialog sentence naming what re-registering would end, or `null` for the same no-claim case. */
  readonly sentence: string | null;
}

interface BusySubject {
  readonly phrase: string;
  readonly plural: boolean;
}

/** A typed all-zero breakdown is Idle only when `busy === false`. `busy && all-zero` is the in-flight create
 * window (`pendingCreates` is not a breakdown field) - generic "Busy", never Idle. */
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

/** And-joined noun phrase for drain-gate copy ("2 agents and 1 terminal"), or `null` when the breakdown names
 * no work. */
export function busyWorkPhrase(breakdown: HostBusyBreakdown): string | null {
  const subjects = breakdownSubjects(breakdown);
  if (subjects.length === 0) return null;
  return joinSubjectPhrases(subjects);
}

/** The verdict still carries two channels that must not be conflated when there is no breakdown: the session
 * count (what the drain projection can count) and the `blockers` breakdown (working agents and live PTYs. */
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
    // Busy with nothing nameable: an old host's zero count, an uncomposed oracle, or a claim another actor already
    // holds. Say the host is busy without inventing a subject the host never stated.
    return "The host is still finishing other work.";
  }
  return sentenceFromSubjects(subjects);
}

/** `forceOffered` is required rather than assumed, because the closing sentence promises a control. */
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
