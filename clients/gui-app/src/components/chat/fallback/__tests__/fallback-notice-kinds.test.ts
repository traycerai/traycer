import { describe, expect, it } from "vitest";
import { providerNoticeKindSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { isFallbackNoticeKind } from "@/components/chat/fallback/fallback-notice-kinds";

describe("isFallbackNoticeKind", () => {
  it("is true for every fallback-engine notice kind and false for every other provider notice", () => {
    // Guards the loop itself: without this, a future enum rename (or the
    // FALLBACK_NOTICE_KINDS set falling out of step with the schema) could
    // silently stop covering the fallback kinds at all - both sides would
    // agree on `false` for everything and the loop below would pass having
    // asserted nothing, exactly as it did for `fallback_returned` and
    // `fallback_return_blocked` before this file was updated for them.
    expect(providerNoticeKindSchema.options).toContain("fallback_applied");
    expect(providerNoticeKindSchema.options).toContain("fallback_wait_resumed");
    expect(providerNoticeKindSchema.options).toContain("fallback_settled");
    expect(providerNoticeKindSchema.options).toContain("fallback_returned");
    expect(providerNoticeKindSchema.options).toContain(
      "fallback_return_blocked",
    );

    let trueCount = 0;
    for (const kind of providerNoticeKindSchema.options) {
      // Derived from the PREFIX, not from a list of the five kinds that exist
      // today. A hard-coded disjunction makes this loop vacuous for the sixth
      // one: a `fallback_*` kind added to the enum with no GUI update would be
      // `expected === false`, `isFallbackNoticeKind` would agree, and every
      // assertion here would pass having asserted nothing about the kind that
      // was just added - which is precisely the direction row #4 arrived from.
      // `trueCount` below is what pins the count at five, so the two halves
      // fail in opposite directions: this catches a kind the set forgot, that
      // catches a kind the enum lost.
      const expected = kind.startsWith("fallback_");
      if (expected) trueCount += 1;
      // Falsification: remove "fallback_return_blocked" from FALLBACK_NOTICE_KINDS in fallback-notice-kinds.ts and THIS assertion must go red.
      expect(isFallbackNoticeKind(kind)).toBe(expected);
    }
    expect(trueCount).toBe(5);
  });
});
