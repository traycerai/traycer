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
    expect(hostStreamRpcRegistry["chat.subscribe"][1].latestMinor).toBe(4);
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
    // A hypothetical peer on some future, unbridgeable chat.subscribe major -
    // exercises the method-isolation property below, independent of
    // chat.subscribe's real, currently-bridgeable version history.
    const skewedManifest = {
      ...currentManifest,
      "chat.subscribe": { major: 2, minor: 0 },
    };

    const fullConnection = checkStreamCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      skewedManifest,
      "host",
    );
    expect(fullConnection.ok).toBe(false);

    const epicSubscribe = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      skewedManifest,
      "host",
      "epic.subscribe",
    );
    expect(epicSubscribe.ok).toBe(true);

    const chatSubscribe = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      skewedManifest,
      "host",
      "chat.subscribe",
    );
    expect(chatSubscribe.ok).toBe(false);
  });

  // Regression guard for the release-v1.1.0 RC incident: chat.subscribe
  // bumped to a new major (dropping the v1.0 registration entirely) and broke
  // every host still running host-v1.0.0. Fixed by keeping chat.subscribe on
  // major 1 and shipping the background-items controls as additive minors, so a
  // current app must still bridge to a host that only advertises 1.0.
  it("bridges chat.subscribe@1.3 to a host still on chat.subscribe@1.0 (host-v1.0.0)", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    const hostV100Manifest = {
      ...currentManifest,
      "chat.subscribe": { major: 1, minor: 0 },
    };

    const fullConnection = checkStreamCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      hostV100Manifest,
      "client",
    );
    expect(fullConnection.ok).toBe(true);

    // Mirrored host-role check: host-v1.0.0 itself, running this same check
    // from its own (older) side against a 1.2 client's manifest, must reach the
    // same verdict - the host's own subscribe-time compatibility gate runs with
    // `selfRole: "host"`, not "client".
    const fullConnectionAsHost = checkStreamCompatibility(
      hostStreamRpcRegistry,
      hostV100Manifest,
      currentManifest,
      "host",
    );
    expect(fullConnectionAsHost.ok).toBe(true);

    const chatSubscribeAsHost = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      hostV100Manifest,
      currentManifest,
      "host",
      "chat.subscribe",
    );
    expect(chatSubscribeAsHost.ok).toBe(true);

    const chatSubscribe = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      hostV100Manifest,
      "client",
      "chat.subscribe",
    );
    expect(chatSubscribe.ok).toBe(true);
  });
});
