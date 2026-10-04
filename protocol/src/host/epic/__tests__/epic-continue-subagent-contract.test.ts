import { describe, expect, it, vi } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  continueSubagentRequestSchema,
  continueSubagentResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

const REFUSAL_REASONS = [
  "unsupported_harness",
  "block_not_subagent",
  "still_running",
  "session_unreadable",
  "creation_failed",
] as const;

describe("epic.continueSubagent@1.0", () => {
  it("is registered at 1.0 and unsupported on a host that predates it", () => {
    const entry = hostRpcRegistry["epic.continueSubagent"];
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(entry.degrade).toEqual({ kind: "unsupported" });
  });

  it("loads the registry without throwing (it validates at import)", async () => {
    vi.resetModules();
    await expect(import("@traycer/protocol/host/index")).resolves.toBeDefined();
  });

  describe("request", () => {
    const valid = { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" };

    it("accepts the three ids", () => {
      expect(continueSubagentRequestSchema.parse(valid)).toEqual(valid);
    });

    it.each(["epicId", "chatId", "blockId"] as const)(
      "rejects an empty %s",
      (field) => {
        expect(
          continueSubagentRequestSchema.safeParse({ ...valid, [field]: "" })
            .success,
        ).toBe(false);
      },
    );
  });

  describe("response", () => {
    it.each(["created", "existing"] as const)("accepts %s", (kind) => {
      const value = { kind, epicId: "epic-1", chatId: "chat-1" };
      expect(continueSubagentResponseSchema.parse(value)).toEqual(value);
    });

    it.each(["created", "existing"] as const)(
      "rejects %s with an empty id",
      (kind) => {
        expect(
          continueSubagentResponseSchema.safeParse({
            kind,
            epicId: "epic-1",
            chatId: "",
          }).success,
        ).toBe(false);
        expect(
          continueSubagentResponseSchema.safeParse({
            kind,
            epicId: "",
            chatId: "chat-1",
          }).success,
        ).toBe(false);
      },
    );

    it.each(REFUSAL_REASONS)("accepts refused with reason %s", (reason) => {
      const value = { kind: "refused", reason, detail: "which record" };
      expect(continueSubagentResponseSchema.parse(value)).toEqual(value);
    });

    it("rejects an unknown kind", () => {
      expect(
        continueSubagentResponseSchema.safeParse({
          kind: "queued",
          epicId: "epic-1",
          chatId: "chat-1",
        }).success,
      ).toBe(false);
    });

    it("rejects an unknown refusal reason", () => {
      expect(
        continueSubagentResponseSchema.safeParse({
          kind: "refused",
          reason: "because",
          detail: "",
        }).success,
      ).toBe(false);
    });
  });
});
