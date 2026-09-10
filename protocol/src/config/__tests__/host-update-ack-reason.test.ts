import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STALE_ATTEMPT_CLOSED_SUFFIX,
  baseDispatchAckReason,
  dispatchAckReasonClosedStaleAttempt,
  isValidUpdateDispatchAckReason,
} from "../host-update-ack-reason";

/**
 * Every base reason minted anywhere in the CLI's dispatch path, censused at
 * `0b326c31e` from `update-executor.ts` and `update-run.ts`.
 *
 * The list is here to be ROUND-TRIPPED, not to be the vocabulary: the point of
 * the helper is that the vocabulary is generated rather than enumerated, so a
 * new base reason must not need a change here to be handled correctly. It is
 * the generator's budget that this list checks.
 */
const BASE_REASONS = [
  "nothing-to-do",
  "record-fail-closed",
  "refused-attempt-gone",
  // P1 window B's third answer at the binding site: present, named, and MOVED.
  //
  // 21 characters, so the suffixed form is 42 and stays inside the wire
  // pattern's 64. That is the whole claim this entry makes, and the docblock
  // is why: this list checks the GENERATOR'S BUDGET, not the vocabulary, so a
  // new base needs no change here to be handled correctly. A note about which
  // bases a producer can actually EMIT suffixed would be authority the list
  // disclaims - however true it happened to be on the day it was written.
  "refused-attempt-moved",
  "refused-unverifiable",
  "recovered-complete",
  "recovered-failed",
  "intent-not-legal",
  "cohort-disabled",
  // No producer remains after this plan, and it stays in the GRAMMAR: the GUI
  // still compares against it, so a consumer reading a reason off the wire can
  // still meet it. Included here because the helper's job is the vocabulary,
  // not the subset the CLI happens to mint this week.
  "refused-install-changed",
] as const;

describe("dispatch ack reason", () => {
  it("the leaf imports NOTHING from `node:` - the property that makes it renderer-safe", () => {
    // Read as SOURCE, deliberately. This is the one defect in this module that
    // neither `tsgo` nor this suite can otherwise see: a `node:` import here
    // type-checks, passes under vitest's node environment, and fails only in
    // the renderer's production bundle - which is exactly how the vocabulary
    // ended up unreachable from the GUI in the first place (`host-update-ack.ts`
    // imports `node:path`, which is why this leaf exists at all).
    const source = readFileSync(
      new URL("../host-update-ack-reason.ts", import.meta.url),
      "utf8",
    );
    // Comments in this file DISCUSS `node:`, so the test is about imports, not
    // about the characters appearing anywhere.
    const imports = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b.*\bfrom\s+["']/.test(line));
    expect(imports.filter((line) => line.includes("node:"))).toEqual([]);
  });

  it("the suffix is the one the GENERATOR appends, not a retyped copy", () => {
    // The single-definition claim, and the only way to check it from here: the
    // CLI's `staleAttemptClosedReason` builds `${reason}${SUFFIX}` from this
    // very constant, so a drift would have to be a drift of one value against
    // itself. What is pinned is the spelling, which is what a consumer that
    // ever hard-coded the literal would be matching against.
    expect(STALE_ATTEMPT_CLOSED_SUFFIX).toBe("-stale-attempt-closed");
  });

  it.each(BASE_REASONS)(
    "`%s` round-trips through suffix then strip",
    (base) => {
      const suffixed = `${base}${STALE_ATTEMPT_CLOSED_SUFFIX}`;
      // The generator only appends when the result still fits the wire pattern,
      // so a base that does NOT fit would be handed back undecorated and this
      // round trip would be vacuous. Every base reason in play today fits, which
      // is exactly why the value space is ~2N and why an `===` on a literal is
      // the wrong shape.
      expect(isValidUpdateDispatchAckReason(suffixed)).toBe(true);
      expect(baseDispatchAckReason(suffixed)).toBe(base);
      expect(dispatchAckReasonClosedStaleAttempt(suffixed)).toBe(true);
      // Undecorated, the same reason must survive untouched.
      expect(baseDispatchAckReason(base)).toBe(base);
      expect(dispatchAckReasonClosedStaleAttempt(base)).toBe(false);
    },
  );

  it("a reason that is not a suffixed form is returned UNCHANGED", () => {
    // The half that keeps this from being a blunt string edit: stripping must
    // be conditional, or every consumer silently loses characters.
    expect(baseDispatchAckReason("nothing-to-do")).toBe("nothing-to-do");
    expect(baseDispatchAckReason("")).toBe("");
    // Contains the words but does not END with the suffix.
    expect(baseDispatchAckReason("stale-attempt-closed-but-not-a-suffix")).toBe(
      "stale-attempt-closed-but-not-a-suffix",
    );
  });

  it("the suffixed form of `recovered-complete` is PRODUCIBLE, which is why a literal was the wrong shape", () => {
    // The row cold review C asked for by name. It is 39 characters, inside the
    // 64-character budget, so the generator would emit it and a guard keyed on
    // the literal `recovered-complete` would miss the suffixed form of the very
    // reason it means to admit.
    //
    // What this row does NOT claim: that the CLI produces it today. It cannot
    // - `staleAttemptClosedReason` is applied to the SELECTOR's reason, and the
    // selector never returns `recovered-complete` (that spelling is projected
    // later, from a terminalized segment). This pins the grammar, which is what
    // a shared helper owes its consumers, and the distinction between what the
    // grammar admits and what today's topology emits is exactly the thing a
    // hard-coded list gets wrong first.
    const suffixed = `recovered-complete${STALE_ATTEMPT_CLOSED_SUFFIX}`;
    expect(suffixed).toHaveLength(39);
    expect(isValidUpdateDispatchAckReason(suffixed)).toBe(true);
    expect(baseDispatchAckReason(suffixed)).toBe("recovered-complete");
    expect(dispatchAckReasonClosedStaleAttempt(suffixed)).toBe(true);
  });
});
