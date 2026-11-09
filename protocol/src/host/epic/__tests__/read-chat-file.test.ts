import { describe, expect, it } from "vitest";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { FILE_ATTACHMENT_MAX_BASE64_LENGTH } from "@traycer/protocol/host/drafts/schemas";
import {
  readChatFileRequestSchema,
  readChatFileResponseSchema,
} from "@traycer/protocol/host/epic/chat-file";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

const REQUEST = {
  epicId: "epic-1",
  chatId: "chat-1",
  hash: "ab".repeat(32),
};

const FOUND = {
  ok: true as const,
  bytesBase64: "AQID",
};

describe("epic.readChatFile@1.0", () => {
  it("is advertised only as an optional method, never on the released floor", () => {
    const split = splitConnectionManifest(
      { "epic.readChatFile": hostRpcRegistry["epic.readChatFile"] },
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.manifest["epic.readChatFile"]).toBeUndefined();
    expect(split.optionalManifest["epic.readChatFile"]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("parses both response arms", () => {
    expect(readChatFileResponseSchema.parse(FOUND)).toEqual(FOUND);
    expect(
      readChatFileResponseSchema.parse({ ok: false, reason: "missing" }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a found body over the file cap", () => {
    expect(
      readChatFileResponseSchema.safeParse({
        ...FOUND,
        bytesBase64: "A".repeat(FILE_ATTACHMENT_MAX_BASE64_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["non-hex", "z".repeat(64)],
    ["uppercase", "AB".repeat(32)],
    ["short", "ab".repeat(31)],
  ])("rejects a %s hash", (_label, hash) => {
    expect(
      readChatFileRequestSchema.safeParse({ ...REQUEST, hash }).success,
    ).toBe(false);
  });

  it("accepts the local-only plane selector and its absence", () => {
    expect(
      readChatFileRequestSchema.parse({ ...REQUEST, plane: "local-only" }),
    ).toEqual({ ...REQUEST, plane: "local-only" });
    expect(readChatFileRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });
});
