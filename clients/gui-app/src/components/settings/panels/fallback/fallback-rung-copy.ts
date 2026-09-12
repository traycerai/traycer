import type { FallbackRungKind } from "@traycer/protocol/host/fallback-policy";

/**
 * User-facing copy for the four ladder steps.
 *
 * The vocabulary is settled and narrow: "try these in order" and "step", never
 * "ladder" or "rung", which are engine words. `Record<FallbackRungKind, …>`
 * rather than a lookup with a fallback, so a fifth step cannot ship without
 * copy - the same discipline the host applies to its own reason maps.
 */
export interface FallbackRungCopy {
  /** The step's own line in "Try these in order". */
  readonly label: string;
  /** One line under it saying what the step actually does. */
  readonly description: string;
  /**
   * The short form used as a column chip in the per-failure overrides matrix,
   * where the row already names the failure and the full sentence would not
   * fit. Deliberately the same three words the wireframe uses.
   */
  readonly chipLabel: string;
}

export const FALLBACK_RUNG_COPY: Record<FallbackRungKind, FallbackRungCopy> = {
  profile: {
    label: "Switch to another profile of the same provider",
    description:
      "Continues on a different account you have signed in to for that provider.",
    chipLabel: "other profile",
  },
  tier: {
    label: "Switch to an equivalent model on another provider",
    // "the equivalent models below", NOT "the model groups below". A group is
    // policy STRUCTURE, and the vocabulary table bans naming it for the same
    // reason it bans "tier", "ladder" and "rung" - this line was the last place
    // the word survived in shipped copy, and it sat directly above a section
    // whose own heading is "Equivalent models", so the page named one thing two
    // ways.
    description:
      "Uses the equivalent models below to find one you have said is interchangeable.",
    chipLabel: "equivalent model",
  },
  wait: {
    label: "Wait for the limit to reset",
    description:
      "Only when the provider has told us when the limit resets, and the wait is inside the cap below.",
    chipLabel: "wait",
  },
  notify: {
    label: "Notify me",
    // NOT "Always runs when nothing else worked". This description renders for
    // the row whatever the stored ladder holds, including a ladder that omits
    // `notify` entirely - the state where the editor offers "Add this step
    // back" precisely because the step does NOT run. `FixedStepControl` is
    // where "Always" belongs, and it already says it only in the `enabled`
    // branch; saying it here too put the claim beside its own contradiction,
    // which `fallback-ladder-editor.tsx` documents at its `FixedStepControl`.
    description: "Runs at the end of the plan, once the steps above are spent.",
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
