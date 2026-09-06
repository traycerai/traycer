import { describe, expect, it } from "vitest";
import { providerNoticeKindSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { isFallbackNoticeKind } from "@/components/chat/fallback/fallback-notice-kinds";

describe("isFallbackNoticeKind", () => {
  it("is true only for the three fallback notice kinds", () => {
    for (const kind of providerNoticeKindSchema.options) {
      const expected =
        kind === "fallback_applied" ||
        kind === "fallback_wait_resumed" ||
        kind === "fallback_settled";
      expect(isFallbackNoticeKind(kind)).toBe(expected);
    }
  });
});
