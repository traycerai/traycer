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
    // `wire` omits `definitive` on purpose: that is what a host that
    // predates the field sends. The schema's `.default(null)` is what lets
    // a new client read that absence as "no terminal cause known" instead
    // of failing the parse, so the parsed side gains a key the wire side
    // never had.
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual({
      ...wire,
      definitive: null,
    });
  });

  it("round-trips an unpublished response", () => {
    const wire = {
      published: false,
      boundaryCovered: null,
      publishedThroughTs: null,
    };
    // Same reasoning as above: an old-host payload has no `definitive` key,
    // and the parsed result defaults it to `null` rather than leaving it
    // absent.
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual({
      ...wire,
      definitive: null,
    });
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

describe("chatPublicationStateResponseSchema definitive", () => {
  // `definitive` is the "stop polling, this will never resolve" mechanism:
  // any caller that treats an unrecognised value as `null` reintroduces the
  // infinite wait, so this coverage pins the round-trip for every known
  // reason plus the explicit-null and rejection cases.
  const base = {
    published: false,
    boundaryCovered: null,
    publishedThroughTs: null,
  };

  it.each([
    "chat-deleted",
    "lineage-superseded",
    "backup-halted",
  ] as const)("round-trips definitive: %s", (reason) => {
    const wire = { ...base, definitive: reason };
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual(wire);
  });

  it("keeps an explicitly-sent null as null", () => {
    const wire = { ...base, definitive: null };
    expect(chatPublicationStateResponseSchema.parse(wire)).toEqual(wire);
  });

  // z.enum(...).nullable().default(null) only substitutes the default when
  // the field is UNDEFINED (see the omitted-key round-trips above). A
  // present-but-unrecognised string is neither a member of the enum nor
  // `null`, so it fails validation outright rather than being coerced to
  // `null` - verified here rather than assumed.
  it("rejects an unrecognized definitive reason", () => {
    expect(
      chatPublicationStateResponseSchema.safeParse({
        ...base,
        definitive: "some-future-reason",
      }).success,
    ).toBe(false);
  });
});
