import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  setChatArchivedRequestSchema,
  setChatArchivedResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";

/**
 * `epic.setChatArchived` is a new ADDITIVE unary method. It must ride the
 * optional-capabilities channel, not the released floor: entering the floor
 * would be handshake-fatal for every peer that shipped before this method
 * existed (see the doc comment on `epicSetChatArchivedV10` in contracts.ts).
 */
describe("epic.setChatArchived is optional, not floor", () => {
  it("is absent from RELEASED_FLOOR_METHOD_NAMES", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("epic.setChatArchived");
  });

  it("is absent from the guarded released-method-name fixture", () => {
    expect(releasedMethodNames).not.toContain("epic.setChatArchived");
  });

  it("advertises on the optional manifest at 1.0, not the floor manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.optionalManifest["epic.setChatArchived"]).toEqual({
      major: 1,
      minor: 0,
    });
    expect(split.manifest["epic.setChatArchived"]).toBeUndefined();
  });

  it("declares an explicit degrade strategy for missing-peer behavior", () => {
    expect(
      Object.hasOwn(hostRpcRegistry["epic.setChatArchived"], "degrade"),
    ).toBe(true);
  });
});

describe("setChatArchivedRequestSchema", () => {
  const base = { epicId: "epic-1", chatId: "chat-1" };

  it("accepts a well-formed archive request", () => {
    expect(
      setChatArchivedRequestSchema.safeParse({ ...base, archived: true })
        .success,
    ).toBe(true);
  });

  it("accepts a well-formed unarchive request", () => {
    expect(
      setChatArchivedRequestSchema.safeParse({ ...base, archived: false })
        .success,
    ).toBe(true);
  });

  it("rejects a missing archived flag", () => {
    expect(setChatArchivedRequestSchema.safeParse(base).success).toBe(false);
  });

  it("rejects a wrong-typed archived flag", () => {
    expect(
      setChatArchivedRequestSchema.safeParse({ ...base, archived: "true" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing epicId", () => {
    expect(
      setChatArchivedRequestSchema.safeParse({
        chatId: "chat-1",
        archived: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing chatId", () => {
    expect(
      setChatArchivedRequestSchema.safeParse({
        epicId: "epic-1",
        archived: true,
      }).success,
    ).toBe(false);
  });
});

describe("setChatArchivedResponseSchema", () => {
  it("accepts { updated: true }", () => {
    expect(
      setChatArchivedResponseSchema.safeParse({ updated: true }).success,
    ).toBe(true);
  });

  it("accepts { updated: false }", () => {
    expect(
      setChatArchivedResponseSchema.safeParse({ updated: false }).success,
    ).toBe(true);
  });

  it("rejects a wrong-typed updated flag", () => {
    expect(
      setChatArchivedResponseSchema.safeParse({ updated: "true" }).success,
    ).toBe(false);
  });
});
