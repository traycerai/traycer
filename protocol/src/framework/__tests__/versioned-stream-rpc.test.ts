import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  validateVersionedStreamRpcRegistry,
  type UncheckedVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  buildStreamManifest,
  checkStreamCompatibility,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Structural and schema-compatibility tests for the versioned streaming-RPC
 * framework plus a smoke test that `defineVersionedStreamRpcRegistry`
 * accepts the real combined registry shipped from
 * `@traycer/protocol/host/registry`.
 */

describe("validateVersionedStreamRpcRegistry", () => {
  it("accepts the combined hostStreamRpcRegistry", () => {
    expect(() => {
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry);
    }).not.toThrow();
    expect(hostStreamRpcRegistry["epic.subscribe"][1].latestMinor).toBe(0);
    expect(hostStreamRpcRegistry["chat.subscribe"][2].latestMinor).toBe(0);
    expect(
      hostStreamRpcRegistry["notifications.subscribe"][1].latestMinor,
    ).toBe(0);
  });

  it("rejects a minor that drops a server-frame field from an earlier minor", () => {
    const snapshotV10 = defineStreamRpcContract({
      method: "stream.test",
      schemaVersion: { major: 1, minor: 0 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          id: z.string(),
          hasBinaryPayload: z.literal(true),
        }),
        z.object({
          kind: z.literal("pong"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    const snapshotV11DropsField = defineStreamRpcContract({
      method: "stream.test",
      schemaVersion: { major: 1, minor: 1 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          // `id` dropped across minors of the same major - not additive.
          hasBinaryPayload: z.literal(true),
        }),
        z.object({
          kind: z.literal("pong"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    const invalidRegistry: UncheckedVersionedStreamRpcRegistry = {
      "stream.test": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: snapshotV10 },
            1: { contract: snapshotV11DropsField },
          },
        },
      },
    };

    expect(() => validateVersionedStreamRpcRegistry(invalidRegistry)).toThrow(
      "Minor 1.1 for method 'stream.test' drops serverFrame field 'snapshot.id' from 1.0",
    );
  });

  it("rejects a major bump whose sub-schemas are all purely additive", () => {
    const additiveV10 = defineStreamRpcContract({
      method: "stream.additive",
      schemaVersion: { major: 1, minor: 0 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    const additiveV20 = defineStreamRpcContract({
      method: "stream.additive",
      schemaVersion: { major: 2, minor: 0 } as const,
      // Every sub-schema strictly adds fields - no drop, no change - so this
      // should have shipped as 1.1 rather than 2.0.
      openRequestSchema: z.object({
        id: z.string(),
        extra: z.string(),
      }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
          newField: z.string(),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
          correlationId: z.string(),
        }),
      ]),
    });

    const invalidRegistry: UncheckedVersionedStreamRpcRegistry = {
      "stream.additive": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: additiveV10 },
          },
        },
        2: {
          latestMinor: 0,
          versions: {
            0: { contract: additiveV20 },
          },
        },
      },
    };

    expect(() => validateVersionedStreamRpcRegistry(invalidRegistry)).toThrow(
      "Major bump 1 -> 2 for method 'stream.additive' is not a breaking change (could have shipped as a minor)",
    );
  });

  it("accepts a major bump that drops a server-frame variant", () => {
    const breakingV10 = defineStreamRpcContract({
      method: "stream.breaking",
      schemaVersion: { major: 1, minor: 0 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
        }),
        z.object({
          kind: z.literal("legacy"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    const breakingV20 = defineStreamRpcContract({
      method: "stream.breaking",
      schemaVersion: { major: 2, minor: 0 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    expect(() =>
      defineVersionedStreamRpcRegistry({
        "stream.breaking": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: breakingV10 },
            },
          },
          2: {
            latestMinor: 0,
            versions: {
              0: { contract: breakingV20 },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects a contract whose method does not match the registry key", () => {
    const misnamedV10 = defineStreamRpcContract({
      method: "stream.other",
      schemaVersion: { major: 1, minor: 0 } as const,
      openRequestSchema: z.object({}),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("pong"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });

    const invalidRegistry: UncheckedVersionedStreamRpcRegistry = {
      "stream.expected": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: misnamedV10 },
          },
        },
      },
    };

    expect(() => validateVersionedStreamRpcRegistry(invalidRegistry)).toThrow(
      "Contract method 'stream.other' does not match registry method 'stream.expected'",
    );
  });
});

describe("stream compatibility", () => {
  it("allows a compatible subscribed method when another stream method has major skew", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    const olderChatManifest = {
      ...currentManifest,
      "chat.subscribe": { major: 1, minor: 0 },
    };

    const fullConnection = checkStreamCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderChatManifest,
      "host",
    );
    expect(fullConnection.ok).toBe(false);

    const epicSubscribe = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderChatManifest,
      "host",
      "epic.subscribe",
    );
    expect(epicSubscribe.ok).toBe(true);

    const chatSubscribe = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderChatManifest,
      "host",
      "chat.subscribe",
    );
    expect(chatSubscribe.ok).toBe(false);
  });
});
