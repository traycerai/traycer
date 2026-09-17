import type { FallbackRungKind } from "@traycer/protocol/host/fallback-policy";

/**
 * User-facing copy for the four ladder steps.
 *
 * The vocabulary is settled and narrow: "try these in order" and "step", never
 * "ladder" or "rung", which are engine words. `Record<FallbackRungKind, …>`
 * rather than a lookup with a fallback, so a fifth step cannot ship without
 * copy - the same discipline the host applies to its own reason maps.
 *
 * ## Why the labels are not all one grammar
 *
 * `profile` and `tier` are NOUN phrases naming a destination; `wait` and
 * `notify` are VERB phrases naming an action. That is the distinction, not an
 * inconsistency: the first two say where the turn goes, and the last two are
 * what Traycer does when it is not moving the turn anywhere. Every label
 * completes the heading above the list - "try these in order" - and forcing the
 * last two into noun phrases ("Notifying you") buys symmetry by making the
 * list read worse.
 *
 * ## What a description owes the reader
 *
 * Something the LABEL does not already say, and something they can ACT on.
 * Each of the four used to restate its own label in longer words, which is what
 * made the page read as verbose rather than merely long. A user-lens review of
 * the rewrite then found the replacements were still explaining the system to
 * someone who already knew it, so each now answers the question a reader
 * actually arrives with - where do I set this up, what does Traycer wait for,
 * what happens when it gives up.
 *
 * ## "account", not "profile"
 *
 * One concept, one word, everywhere on this page - the label, the description
 * and the matrix chip. The split survived the first pass because the chip is a
 * column header and "profile" is shorter; that traded a page-wide vocabulary
 * for two characters. Providers keeps its own "profile" wording, because there
 * it is the name of a real control the user is being sent to find.
 */
export interface FallbackRungCopy {
  /** The step's own line in "Try these in order". */
  readonly label: string;
  /** One line under it saying what the step actually does. */
  readonly description: string;
  /**
   * The short form used as a column chip in the per-failure overrides matrix,
   * where the row already names the failure and the full sentence would not
   * fit.
   */
  readonly chipLabel: string;
}

export const FALLBACK_RUNG_COPY: Record<FallbackRungKind, FallbackRungCopy> = {
  profile: {
    label: "Another account on the same provider",
    description: "Continues on a different account you're signed in to.",
    chipLabel: "other account",
  },
  tier: {
    label: "An equivalent model on another provider",
    // Never "model groups", "tier", "ladder" or "rung" - engine words, and
    // "groups" would name under a second name the thing the tab already calls
    // Equivalent models.
    //
    // This line has now failed twice in opposite directions, which is what
    // fixed its shape. It was CIRCULAR ("uses your equivalent models to find
    // one you have said is interchangeable" - the term defined by itself), and
    // the fix for that was still unactionable ("a model you've marked
    // interchangeable"), because a reader has marked nothing and has no idea
    // where marking happens. Defaults exist without anyone having marked them.
    // So it names the DESTINATION - the tab - rather than trying to define
    // equivalence in one line at all. That is where the answer is.
    description: "Tries a backup model from the Equivalent models tab.",
    chipLabel: "equivalent model",
  },
  wait: {
    label: "Wait for the limit to reset",
    // Two different "limits" used to collide in one sentence - the PROVIDER's
    // usage limit and the user's own longest-wait setting - leaving the reader
    // to sort out which was which. Naming the first as the provider's and the
    // second as "your longest wait" keeps both without the collision, and the
    // sentence also says what happens AFTER the wait, which no earlier version
    // did: the blocked message is retried.
    //
    // The CONDITION leads, and that was a correction. Disentangling the two
    // limits lost the original's "only when the provider has told us when",
    // leaving "waits, then retries - if it resets within your longest wait",
    // which reads as "wait up to my chosen duration". A user whose provider
    // publishes no reset time would expect a wait and get a skipped step. The
    // precondition is the whole gate on this rung, so it goes first.
    description:
      "If the provider gives a reset time within your longest wait, Traycer waits until then and retries the message.",
    chipLabel: "wait",
  },
  notify: {
    label: "Notify me",
    // Asserts TERMINATION, never position. Three wordings failed on that
    // before this one:
    //
    //   - "Always runs when nothing else worked" contradicts the state where
    //     the ladder omits `notify` and the editor offers "Add this step back";
    //     "Always" belongs on `FixedStepControl`, which already says it.
    //   - "Runs at the end of the plan" is false for an externally authored
    //     early `notify`, which this editor renders at its STORED position with
    //     steps visibly below it.
    //   - "Stops here - nothing below it runs" was true but ambiguous about
    //     WHAT stops: the chat, the agent, or only Traycer's attempts.
    //
    // Naming Traycer as the subject settles that, and "later steps" is ordinal
    // rather than spatial - so it survives both a reorder and an early
    // `notify`, which a "below" cannot.
    description:
      "Traycer notifies you and stops trying. Later steps won't run.",
    chipLabel: "notify",
  },
};

/**
 * The three steps the per-failure overrides matrix has columns for.
 *
 * `notify` is deliberately absent: it is eligible for every failure that arms
 * at all, so a column of always-green chips would carry no information. It is
 * still part of the stored ladder for each row, which is why every write from
 * that matrix has to carry it through explicitly rather than rebuild the row
 * from the chips on screen.
 */
export const FALLBACK_MATRIX_RUNGS: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
];
