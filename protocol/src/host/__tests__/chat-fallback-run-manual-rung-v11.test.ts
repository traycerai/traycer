import { describe, expect, it } from "vitest";
import { z } from "zod";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/index";
import {
  FALLBACK_ACTION_OUTCOMES,
  FALLBACK_RUNG_REFUSAL_KINDS,
  chatFallbackRunManualRungResponseSchema,
  chatFallbackRunManualRungResponseSchemaV10,
  chatFallbackRunManualRungUpgradeV10ToV11,
  chatFallbackRunManualRungV10,
  chatFallbackRunManualRungV11,
  fallbackRungRefusalKindSchema,
} from "@traycer/protocol/host/chat-fallback";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * `chat.fallback.runManualRung@1.1`: the response gains `detail`, a refusal
 * taxonomy carried only by the two `*_unavailable` outcomes. The refinement is
 * ONE-directional: a non-null `detail` on any other outcome is refused, but
 * `null` is legal everywhere (the 1.0 -> 1.1 upgrade produces it).
 */

const DETAIL_OUTCOMES = ["rung_unavailable", "rung_target_unavailable"];
const DETAIL = {
  kind: "turn_running",
  label: "A turn is running",
  retryable: true,
};

describe("runManualRung@1.1 response: detail is one-directional", () => {
  it("covers both detail-bearing outcomes in the outcome vocabulary", () => {
    for (const outcome of DETAIL_OUTCOMES) {
      expect(FALLBACK_ACTION_OUTCOMES).toContain(outcome);
    }
  });

  for (const outcome of FALLBACK_ACTION_OUTCOMES) {
    const bearsDetail = DETAIL_OUTCOMES.includes(outcome);

    it(`${outcome}: a non-null detail is ${bearsDetail ? "accepted" : "rejected"}`, () => {
      const result = chatFallbackRunManualRungResponseSchema.safeParse({
        outcome,
        detail: DETAIL,
      });
      expect(result.success).toBe(bearsDetail);
    });

    it(`${outcome}: a null detail is accepted`, () => {
      const result = chatFallbackRunManualRungResponseSchema.safeParse({
        outcome,
        detail: null,
      });
      expect(result.success).toBe(true);
    });
  }

  it("the wire accepts an unknown refusal kind string, the closed vocabulary rejects it", () => {
    const result = chatFallbackRunManualRungResponseSchema.safeParse({
      outcome: "rung_unavailable",
      detail: { kind: "from_a_newer_host", label: "Newer", retryable: false },
    });
    expect(result.success).toBe(true);
    expect(
      fallbackRungRefusalKindSchema.safeParse("from_a_newer_host").success,
    ).toBe(false);
  });

  it("restates the 13 refusal kinds (change-detector)", () => {
    expect([...FALLBACK_RUNG_REFUSAL_KINDS]).toEqual([
      "turn_running",
      "routing_active",
      "worktree_missing",
      "no_workspace",
      "message_changed",
      "prelaunch_failed",
      "reset_passed",
      "no_verified_reset",
      "host_unavailable",
      "settings_missing",
      "storage_failed",
      "target_unusable",
      "unknown",
    ]);
    for (const kind of FALLBACK_RUNG_REFUSAL_KINDS) {
      expect(fallbackRungRefusalKindSchema.safeParse(kind).success).toBe(true);
    }
  });
});

describe("runManualRung@1.0 response is a frozen pre-image", () => {
  it("decodes a 1.1 response with detail present, detail absent from the result", () => {
    const parsed = chatFallbackRunManualRungV10.responseSchema.parse({
      outcome: "rung_unavailable",
      detail: DETAIL,
    });
    expect(parsed).toEqual({ outcome: "rung_unavailable" });
    expect(parsed).not.toHaveProperty("detail");
  });

  it("is not the live response schema, and its JSON schema has only outcome", () => {
    expect(chatFallbackRunManualRungResponseSchemaV10).not.toBe(
      chatFallbackRunManualRungResponseSchema,
    );
    expect(chatFallbackRunManualRungV10.responseSchema).not.toBe(
      chatFallbackRunManualRungV11.responseSchema,
    );
    const json = z.toJSONSchema(chatFallbackRunManualRungResponseSchemaV10, {
      io: "output",
      unrepresentable: "any",
    });
    expect(Object.keys(json.properties ?? {})).toEqual(["outcome"]);
  });
});

describe("runManualRung registry and upgrade path", () => {
  it("registers latestMinor 1 with 1.0 and 1.1 bound to their own contracts", () => {
    const line = hostRpcRegistry["chat.fallback.runManualRung"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(chatFallbackRunManualRungV10);
    expect(line.versions[1].contract).toBe(chatFallbackRunManualRungV11);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      chatFallbackRunManualRungUpgradeV10ToV11,
    );
  });

  for (const outcome of FALLBACK_ACTION_OUTCOMES) {
    it(`lifts a 1.0 ${outcome} response to detail: null, valid under the 1.1 schema`, () => {
      const direct = chatFallbackRunManualRungUpgradeV10ToV11.upgradeResponse({
        outcome,
      });
      expect(direct).toEqual({ outcome, detail: null });
      expect(
        chatFallbackRunManualRungResponseSchema.safeParse(direct).success,
      ).toBe(true);

      const viaRegistry = upgradeResponseToVersion(
        hostRpcRegistry["chat.fallback.runManualRung"],
        { major: 1, minor: 0 },
        { major: 1, minor: 1 },
        { outcome },
      );
      expect(viaRegistry).toEqual({ outcome, detail: null });
      expect(
        chatFallbackRunManualRungResponseSchema.safeParse(viaRegistry).success,
      ).toBe(true);
    });
  }
});
