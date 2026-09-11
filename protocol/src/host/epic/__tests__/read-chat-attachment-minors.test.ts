import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  readChatAttachmentRequestSchema,
  readChatAttachmentRequestSchemaPre11,
} from "@traycer/protocol/host/epic/chat-attachment";
import {
  epicReadChatAttachmentUpgradeV10ToV11,
  epicReadChatAttachmentV10,
} from "@traycer/protocol/host/epic/contracts";

const BASE_REQUEST = {
  epicId: "epic-1",
  chatId: "chat-1",
  hash: "a".repeat(64),
};

describe("epic.readChatAttachment@1.1", () => {
  it("is registered alongside the frozen 1.0 contract", () => {
    const registry = hostRpcRegistry["epic.readChatAttachment"];
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

  it("1.0 strips the plane selector from the frozen line", () => {
    const parsed = readChatAttachmentRequestSchemaPre11.parse({
      ...BASE_REQUEST,
      plane: "local-only",
    });
    expect(parsed).not.toHaveProperty("plane");
    expect(parsed).toEqual(BASE_REQUEST);
  });

  it("1.1 round-trips the plane selector and keeps its absence representable", () => {
    expect(
      readChatAttachmentRequestSchema.parse({
        ...BASE_REQUEST,
        plane: "local-only",
      }),
    ).toEqual({ ...BASE_REQUEST, plane: "local-only" });
    const withoutPlane = readChatAttachmentRequestSchema.parse(BASE_REQUEST);
    expect(withoutPlane).not.toHaveProperty("plane");
    expect(withoutPlane).toEqual(BASE_REQUEST);
  });

  it("1.1 rejects an unknown plane value", () => {
    const result = readChatAttachmentRequestSchema.safeParse({
      ...BASE_REQUEST,
      plane: "cloud-only",
    });
    expect(result.success).toBe(false);
  });

  it("the released 1.0 contract points at the frozen request", () => {
    expect(
      epicReadChatAttachmentV10.requestSchema.parse({
        ...BASE_REQUEST,
        plane: "local-only",
      }),
    ).toEqual(BASE_REQUEST);
  });

  it("the 1.0-to-1.1 upgrade path does not synthesize a plane", () => {
    const upgraded =
      epicReadChatAttachmentUpgradeV10ToV11.upgradeRequest(BASE_REQUEST);
    expect(upgraded).not.toHaveProperty("plane");
    expect(upgraded).toEqual(BASE_REQUEST);
  });
});
