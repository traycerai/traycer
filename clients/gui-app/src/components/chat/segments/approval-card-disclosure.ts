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
 */
export const JUDGE_UNAVAILABLE_HUMAN_LINE =
  "Traycer couldn't run the judge, so it's asking you instead.";

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
 */
export function isJudgeUnavailableReason(text: string): boolean {
  return text.startsWith("auto: ");
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
