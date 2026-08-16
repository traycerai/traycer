import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  chatPublicationStateRequestSchema,
  chatPublicationStateResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

const METHOD = "epic.chatPublicationState";

/**
 * Brand-new v1.0 method on the optional-capabilities channel. Landing it on
 * the released floor (or drifting it into the frozen fixture) is
 * handshake-fatal for every peer that shipped before the name existed.
 */
describe("epic.chatPublicationState is optional, not floor", () => {
  it("is present in hostRpcRegistry", () => {
    expect(Object.hasOwn(hostRpcRegistry, METHOD)).toBe(true);
  });

  it("is absent from RELEASED_FLOOR_METHOD_NAMES", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
  });

  it("is absent from the guarded released-method-name fixture", () => {
    expect(releasedMethodNames).not.toContain(METHOD);
  });

  it("advertises on the optional manifest at 1.0, not the floor manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.optionalManifest[METHOD]).toEqual({
      major: 1,
      minor: 0,
    });
    expect(split.manifest[METHOD]).toBeUndefined();
  });

  it("declares an explicit degrade strategy for missing-peer behavior", () => {
    expect(Object.hasOwn(hostRpcRegistry[METHOD], "degrade")).toBe(true);
    expect(hostRpcRegistry[METHOD].degrade).toEqual({
      kind: "unsupported",
    });
  });
});

describe("chatPublicationStateRequestSchema", () => {
  const base = { epicId: "epic-1", chatId: "chat-1" };

  it("parses without boundaryMessageId", () => {
    const parsed = chatPublicationStateRequestSchema.parse(base);
    expect(parsed).toEqual(base);
    expect(Object.hasOwn(parsed, "boundaryMessageId")).toBe(false);
  });

  it("parses with a named boundaryMessageId", () => {
    const parsed = chatPublicationStateRequestSchema.parse({
      ...base,
      boundaryMessageId: "assistant-message-1",
    });
    expect(parsed.boundaryMessageId).toBe("assistant-message-1");
  });

  it("parses an explicit null boundaryMessageId (nullish, not omitted)", () => {
    const parsed = chatPublicationStateRequestSchema.parse({
      ...base,
      boundaryMessageId: null,
    });
    expect(parsed.boundaryMessageId).toBeNull();
  });

  it("rejects a missing epicId", () => {
    expect(
      chatPublicationStateRequestSchema.safeParse({ chatId: "chat-1" }).success,
    ).toBe(false);
  });

  it("rejects a missing chatId", () => {
    expect(
      chatPublicationStateRequestSchema.safeParse({ epicId: "epic-1" }).success,
    ).toBe(false);
  });
});

describe("chatPublicationStateResponseSchema", () => {
  it("round-trips a covered response", () => {
    const wire = {
      published: true,
      boundaryCovered: true,
      publishedThroughTs: 1_700_000_000_000,
    };
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual(wire);
  });

  it("round-trips an unpublished response", () => {
    const wire = {
      published: false,
      boundaryCovered: null,
      publishedThroughTs: null,
    };
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual(wire);
  });

  it("preserves boundaryCovered: null as null, never as false", () => {
    // `null` means NOT ASKED. Coercing it to `false` would tell the caller
    // the boundary is uncovered when they never named one.
    const parsed = chatPublicationStateResponseSchema.parse({
      published: true,
      boundaryCovered: null,
      publishedThroughTs: null,
    });
    expect(parsed.boundaryCovered).toBeNull();
    expect(parsed.boundaryCovered).not.toBe(false);
  });

  it("accepts boundaryCovered: false as a real uncovered answer", () => {
    const parsed = chatPublicationStateResponseSchema.parse({
      published: true,
      boundaryCovered: false,
      publishedThroughTs: 1_700_000_000_000,
    });
    expect(parsed.boundaryCovered).toBe(false);
  });

  it("rejects a missing published flag", () => {
    expect(
      chatPublicationStateResponseSchema.safeParse({
        boundaryCovered: true,
        publishedThroughTs: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing boundaryCovered", () => {
    expect(
      chatPublicationStateResponseSchema.safeParse({
        published: true,
        publishedThroughTs: null,
      }).success,
    ).toBe(false);
  });
});
