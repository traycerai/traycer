import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  deleteChatResponseSchema,
  deleteChatResponseSchemaV10,
} from "@traycer/protocol/host/epic/unary-schemas";
import { epicDeleteChatUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";

describe("epic.deleteChat@1.1", () => {
  it("is registered alongside the frozen 1.0 contract", () => {
    const registry = hostRpcRegistry["epic.deleteChat"];
    expect(registry[1].latestMinor).toBe(1);
    expect(registry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(registry[1].versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });

  it("1.0 strips publicationChatId from the frozen row", () => {
    const parsed = deleteChatResponseSchemaV10.parse({
      deleted: true,
      publicationChatId: "clone-1",
    });
    expect(parsed).not.toHaveProperty("publicationChatId");
    expect(parsed).toEqual({ deleted: true });
  });

  it("1.1 round-trips publicationChatId for both a resolved id and null", () => {
    expect(
      deleteChatResponseSchema.parse({
        deleted: true,
        publicationChatId: "clone-1",
      }),
    ).toEqual({ deleted: true, publicationChatId: "clone-1" });
    expect(
      deleteChatResponseSchema.parse({
        deleted: true,
        publicationChatId: null,
      }),
    ).toEqual({ deleted: true, publicationChatId: null });
  });

  it("1.1 requires publicationChatId - a missing key is rejected, not defaulted", () => {
    const result = deleteChatResponseSchema.safeParse({ deleted: true });
    expect(result.success).toBe(false);
  });

  it("the 1.0-to-1.1 upgrade path reports null - a v1.0 peer cannot know its cloud identity", () => {
    const upgraded = epicDeleteChatUpgradeV10ToV11.upgradeResponse({
      deleted: true,
    });
    expect(upgraded).toEqual({ deleted: true, publicationChatId: null });
  });

  // NOTE for the reviewer, matching `batch-delete-minors.test.ts`'s own note:
  // `upgradeResponse` here is a bare `{ ...response, publicationChatId: null }`
  // - it does not itself refuse a response that already carries the key, it
  // OVERWRITES it. That is fine for this method (a v1.0 peer's raw wire bytes
  // can never carry `publicationChatId` at all - `deleteChatResponseSchemaV10`
  // strips it before `upgradeResponse` ever sees the object), and this test
  // proves the composed guarantee end-to-end rather than a property
  // `upgradeResponse` holds on its own.
  it("publicationChatId injected into a raw v1.0 wire payload never survives the real client pipeline: schema parse, then upgrade", () => {
    const rawWirePayload = { deleted: true, publicationChatId: "smuggled" };
    const parsedAsFromVersion =
      deleteChatResponseSchemaV10.parse(rawWirePayload);
    expect(parsedAsFromVersion).not.toHaveProperty("publicationChatId");
    const upgraded =
      epicDeleteChatUpgradeV10ToV11.upgradeResponse(parsedAsFromVersion);
    expect(upgraded).toEqual({ deleted: true, publicationChatId: null });
  });
});
