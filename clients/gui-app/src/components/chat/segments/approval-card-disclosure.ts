/**
 * The approval card's time-dependent copy, as pure functions.
 *
 * Split out of the queue component because these are the parts worth driving
 * at an exact elapsed value - 14 s versus 16 s versus 31 s - and a rung that
 * only exists inside a component is a rung testable only through a clock. A
 * module that exports a component may export nothing else anyway
 * (`react(only-export-components)`), so the ladder could not have lived beside
 * it.
 */
import { formatMessageTime } from "@/lib/relative-time";

/**
 * The disclosure ladder's two rungs, in seconds.
 *
 * Below the first rung a judged command shows its stage label and nothing
 * else - that covers the measured 4-10 s stage 2 and the 4.97-5.87 s stage 1
 * with headroom, which is EVERY judged command, so the common case stays
 * quiet. The 15 s rung is also the symptom of a judge call queued behind
 * another one: the per-chat queue serialises them, so a row still reading
 * "Checking…" at 15 s is that, visible without a log.
 */
const JUDGE_ELAPSED_RUNG_SECONDS = 15;
const JUDGE_CAP_RUNG_SECONDS = 30;

/**
 * The third rung.
 *
 * "Then it asks you" is the half that prevents the worst reading: a user who
 * believes the wait ends in FAILURE stops the turn; one who knows it ends in a
 * QUESTION waits. It is true for everyone who can read it - the ladder renders
 * only to subscribers, and every row of the attendance truth table with a
 * human subscribed is a card row.
 *
 * "Up to 2 minutes" restates the host's `AUTO_JUDGE_STAGE2_CAP_MS`, which is
 * an enforced constant (`callAdapter` fires the derived abort signal at
 * exactly that value), not a forecast - so a slower model cannot falsify it,
 * it only changes how often anyone reaches this rung. The client cannot read
 * that constant, so moving it means moving this sentence.
 */
export const JUDGE_CAP_NOTICE =
  "Up to 2 minutes, then it asks you. Stop the turn to cancel.";

export interface JudgeWaitDisclosure {
  /** The elapsed counter, from the first rung up. `null` below it. */
  readonly elapsedLabel: string | null;
  /** The cap sentence, from the second rung up. `null` below it. */
  readonly capNotice: string | null;
}

const NO_JUDGE_DISCLOSURE: JudgeWaitDisclosure = {
  elapsedLabel: null,
  capNotice: null,
};

/**
 * What a row that is still with the judge adds beneath its stage label, given
 * how long this stage has been running.
 */
export function judgeWaitDisclosure(
  elapsedSeconds: number,
): JudgeWaitDisclosure {
  if (elapsedSeconds < JUDGE_ELAPSED_RUNG_SECONDS) return NO_JUDGE_DISCLOSURE;
  return {
    elapsedLabel: `${elapsedSeconds}s`,
    capNotice:
      elapsedSeconds < JUDGE_CAP_RUNG_SECONDS ? null : JUDGE_CAP_NOTICE,
  };
}

/**
 * The human half of an `unavailable` verdict, added BESIDE the machine string
 * and never in place of it.
 *
 * Support keeps a greppable constant in a screenshot; the user learns that the
 * mode is not broken and that the command itself is not suspect.
 *
 * There are three of these because the machine strings describe three
 * different things, and one sentence for all of them is FALSE for two: a card
 * carrying `auto: judge returned no verdict` sits directly under 37 s of the
 * judge's own reasoning about the action, so "Traycer couldn't run the judge"
 * contradicts the paragraph above it. What the user is deciding is how much to
 * trust that paragraph, and that turns on whether the judge never ran, ran and
 * could not decide, or ran out of time.
 */
export const JUDGE_DID_NOT_RUN_HUMAN_LINE =
  "Traycer couldn't run the judge, so it's asking you instead.";

/** The judge answered, but not with a verdict this build could read. */
export const JUDGE_NO_VERDICT_HUMAN_LINE =
  "The judge reviewed this but didn't reach a verdict, so it's asking you instead.";

/** The judge was still working when its budget ran out. */
export const JUDGE_OUT_OF_TIME_HUMAN_LINE =
  "The judge didn't finish in time, so it's asking you instead.";

/**
 * Which of the three situations a recognised machine string describes.
 *
 * Not on the wire: the approval reason is `{ rule, text }` and carries no
 * outcome, so the only thing the client can read is the string itself. Putting
 * an outcome on the wire is a protocol change (and seam territory); reading
 * the constants the host already spells is not.
 */
export type JudgeFailureFamily = "did-not-run" | "no-verdict" | "out-of-time";

/**
 * The constants that name a family outright, restated from the host's
 * `auto-judge-service.ts`.
 *
 * Restated rather than shared: the host is a different repo, these strings
 * reach the client only as free text on the wire, and the whole point of
 * matching on them is to notice when one stops arriving in the shape this
 * build expects. A host that renames one lands on the `null` fallback below,
 * which is the old single sentence - degraded copy, never a wrong line.
 */
const JUDGE_FAILURE_FAMILY_BY_REASON: ReadonlyMap<string, JudgeFailureFamily> =
  new Map([
    ["auto: no judge configured", "did-not-run"],
    ["auto: judge failed", "did-not-run"],
    ["auto: judge returned no verdict", "no-verdict"],
    ["auto: unparseable verdict", "no-verdict"],
    ["auto: judge timed out", "out-of-time"],
  ]);

/**
 * The two constants the host builds with a variable tail.
 *
 * `auto: judge unavailable (…)` interpolates the probe's detail or the
 * adapter's error; `auto: judge exceeded <n> min` interpolates
 * `AUTO_JUDGE_STAGE2_CAP_MS` in minutes, which is 2 today and is a host
 * constant the client cannot read - so the prefix, not the rendered number, is
 * what this can match without going stale the day the cap moves.
 */
const JUDGE_FAILURE_FAMILY_BY_PREFIX: ReadonlyArray<
  readonly [string, JudgeFailureFamily]
> = [
  ["auto: judge unavailable (", "did-not-run"],
  ["auto: judge exceeded ", "out-of-time"],
];

/**
 * Whether a card's reason text is one of the judge's unavailability strings
 * rather than the judge's own prose about the action.
 *
 * The wire carries `{ rule, text }` and no outcome, so the discriminator is the
 * `auto: ` prefix every one of those constants is built with - `auto: judge
 * timed out`, `auto: judge unavailable (…)`, `auto: unparseable verdict`,
 * `auto: judge exceeded 2 min`, `auto: judge failed`. They are deliberately
 * kept verbatim (a screenshot of one is a diagnosis), and that prefix is the
 * property this reads. A verdict's own reasoning is a sentence about the
 * action and never starts this way.
 *
 * This is the broad test - "is this a machine string at all" - and it is what
 * decides the mono type and whether a helper line is added. WHICH helper line
 * is `judgeFailureFamily`'s narrower question, which every string this accepts
 * has an answer for, known or fallback.
 */
export function isJudgeUnavailableReason(text: string): boolean {
  return text.startsWith("auto: ");
}

/**
 * The family a machine string belongs to, or `null` for an `auto: ` string
 * this build does not recognise.
 *
 * Deliberately `null` rather than `"did-not-run"` for the unrecognised case,
 * even though both render the same sentence: the host emits four more
 * constants than the three families cover (`auto: turn stopped`, `auto: judge
 * preflight timed out`, `auto: judge tools unavailable`, `auto: account policy
 * could not be read`), and for every one of them "couldn't run the judge" is
 * already true. Keeping them out of the map says so, and keeps the map a list
 * of strings whose copy would be WRONG under the fallback.
 */
export function judgeFailureFamily(text: string): JudgeFailureFamily | null {
  if (!isJudgeUnavailableReason(text)) return null;
  const exact = JUDGE_FAILURE_FAMILY_BY_REASON.get(text);
  if (exact !== undefined) return exact;
  for (const [prefix, family] of JUDGE_FAILURE_FAMILY_BY_PREFIX) {
    if (text.startsWith(prefix)) return family;
  }
  return null;
}

/**
 * The sentence that goes beneath a machine string, for every machine string.
 *
 * Total on purpose: an unknown `auto: ` constant still gets the sentence the
 * card printed before this function existed, so a host that grows a new
 * failure mode degrades to today's copy rather than to a blank line.
 */
export function judgeUnavailableHumanLine(text: string): string {
  const family = judgeFailureFamily(text);
  if (family === "no-verdict") return JUDGE_NO_VERDICT_HUMAN_LINE;
  if (family === "out-of-time") return JUDGE_OUT_OF_TIME_HUMAN_LINE;
  return JUDGE_DID_NOT_RUN_HUMAN_LINE;
}

/** The wait line's companion, true for as long as the card is unanswered. */
export const APPROVAL_PAUSED_LINE = "This turn is paused until you answer.";

/**
 * How long a card has to have been unanswered before it says so.
 *
 * The line exists for the human who walked away and came back; a card the user
 * watched appear needs no "waiting since" stamp, and one that has been up for
 * eleven seconds would read "· 0 minutes". A minute is the first value the
 * sentence can state truthfully.
 */
const APPROVAL_WAIT_LINE_AFTER_MS = 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The elapsed context a returning human needs, or `null` while the card is too
 * young to have any.
 *
 * The card itself is durable - `ensurePendingApproval` persists it and the
 * released `approval.requested` block is journaled, so a resubscribe snapshot
 * carries it - and `requestedAt` has always been on the wire. What was missing
 * is that the row rendered it and showed nothing from it.
 */
export function approvalWaitLine(input: {
  readonly requestedAt: number;
  readonly nowMs: number;
}): string | null {
  const waitedMs = input.nowMs - input.requestedAt;
  if (waitedMs < APPROVAL_WAIT_LINE_AFTER_MS) return null;
  const since = formatMessageTime(input.requestedAt, input.nowMs);
  return `Waiting for you since ${since} · ${formatWaitDuration(waitedMs)}`;
}

function formatWaitDuration(waitedMs: number): string {
  if (waitedMs < HOUR_MS)
    return pluralize(Math.floor(waitedMs / MINUTE_MS), "minute");
  if (waitedMs < DAY_MS)
    return pluralize(Math.floor(waitedMs / HOUR_MS), "hour");
  return pluralize(Math.floor(waitedMs / DAY_MS), "day");
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
