import { describe, expect, it } from "vitest";
import {
  FALLBACK_ACTION_OUTCOMES,
  chatFallbackProceedRequestSchema,
  chatFallbackProceedResponseSchema,
  chatFallbackProceedV10,
} from "@traycer/protocol/host/chat-fallback";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/** `chat.fallback.proceed@1.0`: "Switch/Wait/Retry now" - ends the hold early. */

const REF = {
  epicId: "epic-1",
  chatId: "chat-1",
  traversalId: "trav-1",
  revision: 3,
};

describe("chat.fallback.proceed contract", () => {
  it("is registered and reachable from hostRpcRegistry", () => {
    expect(hostRpcRegistry["chat.fallback.proceed"]).toBeDefined();
  });

  it("degrades as unsupported", () => {
    expect(hostRpcRegistry["chat.fallback.proceed"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("binds major 1 latestMinor 0 to chatFallbackProceedV10", () => {
    const line = hostRpcRegistry["chat.fallback.proceed"][1];
    expect(line.latestMinor).toBe(0);
    expect(line.versions[0].contract).toBe(chatFallbackProceedV10);
    expect(chatFallbackProceedV10.method).toBe("chat.fallback.proceed");
  });

  it("is not in the released floor (a method born after the floor)", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("chat.fallback.proceed");
  });

  it("request accepts a full traversal ref", () => {
    expect(chatFallbackProceedRequestSchema.safeParse(REF).success).toBe(true);
  });

  it("request rejects a missing revision", () => {
    const { revision: _revision, ...rest } = REF;
    expect(chatFallbackProceedRequestSchema.safeParse(rest).success).toBe(
      false,
    );
  });

  it("request rejects a negative revision", () => {
    expect(
      chatFallbackProceedRequestSchema.safeParse({ ...REF, revision: -1 })
        .success,
    ).toBe(false);
  });

  for (const outcome of FALLBACK_ACTION_OUTCOMES) {
    it(`response accepts outcome ${outcome}`, () => {
      expect(
        chatFallbackProceedResponseSchema.safeParse({ outcome }).success,
      ).toBe(true);
    });
  }
});
