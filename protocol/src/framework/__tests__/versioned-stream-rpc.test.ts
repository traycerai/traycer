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
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  selectConnectionManifestForPeer,
} from "@traycer/protocol/framework/capability-manifest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

const handshakeV10 = defineStreamRpcContract({
  method: "handshake.subscribe",
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

const handshakeV20 = defineStreamRpcContract({
  method: "handshake.subscribe",
  schemaVersion: { major: 2, minor: 0 } as const,
  openRequestSchema: z.object({ id: z.string(), generation: z.number() }),
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

/** Additive minor on major 1: one optional open-request field, same frames. */
const handshakeV11 = defineStreamRpcContract({
  method: "handshake.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: z.object({
    id: z.string(),
    // `.default(null)` is what makes this ADDITIVE, as the fixture's name
    // and comment claim: a v1.0 peer never sends the key, so a v1.1 schema
    // that required it would reject every v1.0 open request.
    resumeToken: z.string().nullable().default(null),
  }),
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

const MULTI_MAJOR_STREAM_REGISTRY = defineVersionedStreamRpcRegistry({
  "handshake.subscribe": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: handshakeV10 } },
    },
    2: {
      latestMinor: 0,
      versions: { 0: { contract: handshakeV20 } },
    },
  },
});

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
    expect(hostStreamRpcRegistry["epic.subscribe"][1].latestMinor).toBe(3);
    expect(hostStreamRpcRegistry["chat.subscribe"][1].latestMinor).toBe(8);
    expect(hostStreamRpcRegistry["terminal.subscribe"][1].latestMinor).toBe(6);
    expect(hostStreamRpcRegistry["worktree.deleteByPath"][1].latestMinor).toBe(
      1,
    );
    expect(
      hostStreamRpcRegistry["notifications.subscribe"][1].latestMinor,
    ).toBe(1);
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
    const currentManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
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

  it("bridges a new multi-major peer to a frozen legacy peer through major 1", () => {
    const currentManifest = buildStreamManifest(
      MULTI_MAJOR_STREAM_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const legacyManifest = {
      ...currentManifest,
      "handshake.subscribe": { major: 1, minor: 0 },
    };

    const fromNewSide = checkStreamMethodCompatibility(
      MULTI_MAJOR_STREAM_REGISTRY,
      currentManifest,
      legacyManifest,
      "host",
      "handshake.subscribe",
    );
    const fromLegacySide = checkStreamMethodCompatibility(
      MULTI_MAJOR_STREAM_REGISTRY,
      legacyManifest,
      currentManifest,
      "client",
      "handshake.subscribe",
    );

    expect(fromNewSide).toEqual({ ok: true });
    expect(fromLegacySide).toEqual({ ok: true });
  });

  /**
   * A retained MAJOR is not a retained released contract.
   *
   * This is the negative twin of the test above. Same shape - a multi-major
   * side meeting a frozen peer pinned at `1.0` - except the retained major-1
   * line has DELETED its `v1.0` registration while keeping the line alive at
   * `1.1`. `highestSharedMajor` still answers 1, so before this guard both
   * release oracles went green while the runtime rejected that peer at
   * subscribe time: the handshake selects a concrete `{major, minor}`, and
   * `1.0` was no longer installed to select.
   *
   * That gap is the whole reason the oracles exist, so it has to fail HERE,
   * loudly, at the layer that is supposed to catch it before release.
   */
  it("refuses a peer pinned to a released minor the retained major line no longer installs", () => {
    const registryMissingV10 = defineVersionedStreamRpcRegistry({
      "handshake.subscribe": {
        1: {
          latestMinor: 1,
          versions: { 1: { contract: handshakeV11 } },
        },
        2: {
          latestMinor: 0,
          versions: { 0: { contract: handshakeV20 } },
        },
      },
    });
    const currentManifest = buildStreamManifest(
      registryMissingV10,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    // Exactly what a frozen host-v1.0.0 fixture advertises.
    const legacyManifest = {
      ...currentManifest,
      "handshake.subscribe": { major: 1, minor: 0 },
    };

    const fromNewSide = checkStreamMethodCompatibility(
      registryMissingV10,
      currentManifest,
      legacyManifest,
      "host",
      "handshake.subscribe",
    );

    expect(fromNewSide.ok).toBe(false);
    if (fromNewSide.ok) {
      throw new Error("expected the deleted released minor to be refused");
    }
    expect(fromNewSide.details.code).toBe("INCOMPATIBLE");

    // Control: restoring v1.0 to the same line makes it bridge again, so the
    // refusal above is attributable to the missing minor and nothing else.
    const registryWithV10 = defineVersionedStreamRpcRegistry({
      "handshake.subscribe": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: handshakeV10 },
            1: { contract: handshakeV11 },
          },
        },
        2: {
          latestMinor: 0,
          versions: { 0: { contract: handshakeV20 } },
        },
      },
    });
    const restoredManifest = buildStreamManifest(
      registryWithV10,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(
      checkStreamMethodCompatibility(
        registryWithV10,
        restoredManifest,
        { ...restoredManifest, "handshake.subscribe": { major: 1, minor: 0 } },
        "host",
        "handshake.subscribe",
      ),
    ).toEqual({ ok: true });
  });

  it("keeps a method incompatible when the advertised majors do not intersect", () => {
    const currentManifest = buildStreamManifest(
      MULTI_MAJOR_STREAM_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const peerManifest = {
      ...currentManifest,
      "handshake.subscribe": {
        major: 3,
        minor: 0,
        supportedMajors: [3],
      },
    };

    const result = checkStreamMethodCompatibility(
      MULTI_MAJOR_STREAM_REGISTRY,
      currentManifest,
      peerManifest,
      "host",
      "handshake.subscribe",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected incompatible stream method");
    }
    expect(result.details.code).toBe("INCOMPATIBLE");
    expect(result.details.incompatibleMethods).toEqual([
      {
        method: "handshake.subscribe",
        clientCanonical: { major: 3, minor: 0, supportedMajors: [3] },
        hostCanonical: currentManifest["handshake.subscribe"],
        blocking: "no-bridge",
      },
    ]);
  });

  // Regression guard for the release-v1.1.0 RC incident: chat.subscribe
  // bumped to a new major (dropping the v1.0 registration entirely) and broke
  // every host still running host-v1.0.0. Fixed by keeping chat.subscribe on
  // major 1 and shipping the background-items controls as additive minors, so a
  // current app must still bridge to a host that only advertises 1.0.
  it("bridges chat.subscribe@1.3 to a host still on chat.subscribe@1.0 (host-v1.0.0)", () => {
    const currentManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
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

  it("builds an old-host openAck without browser methods while existing streams remain compatible", () => {
    const {
      "browser.sessions": browserSessionsRegistry,
      "browser.screencast": browserScreencastRegistry,
      ...oldHostStreamRpcRegistry
    } = hostStreamRpcRegistry;
    void browserSessionsRegistry;
    void browserScreencastRegistry;

    const newGuiManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const oldHostManifest = buildStreamManifest(
      oldHostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    // The host's openAck advertises its own manifest intersected with the
    // peer's. `deriveOpenAckManifest` itself lives in the host and is not
    // importable here, but both of its steps are protocol primitives, so the
    // intersection is reproduced rather than assumed: drop the methods the
    // peer never named, then select the shared major/minor per method.
    const peerNamedHostManifest = Object.fromEntries(
      Object.entries(oldHostManifest).filter(([method]) =>
        Object.prototype.hasOwnProperty.call(newGuiManifest, method),
      ),
    );
    const openAckManifest = selectConnectionManifestForPeer(
      oldHostStreamRpcRegistry,
      peerNamedHostManifest,
      newGuiManifest,
    );

    // The new GUI names every method this old host serves, so the
    // intersection is the old host's own manifest verbatim.
    expect(openAckManifest).toEqual(oldHostManifest);
    expect(openAckManifest["browser.sessions"]).toBeUndefined();
    expect(openAckManifest["browser.screencast"]).toBeUndefined();
    expect(openAckManifest["terminal.subscribe"]).toEqual({
      major: 1,
      minor: 6,
      supportedMajors: [1],
    });

    const terminalAsHost = checkStreamMethodCompatibility(
      oldHostStreamRpcRegistry,
      oldHostManifest,
      newGuiManifest,
      "host",
      "terminal.subscribe",
    );
    expect(terminalAsHost.ok).toBe(true);

    const browserSessionsAsClient = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      newGuiManifest,
      openAckManifest,
      "client",
      "browser.sessions",
    );
    expect(browserSessionsAsClient.ok).toBe(false);

    const browserScreencastAsClient = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      newGuiManifest,
      openAckManifest,
      "client",
      "browser.screencast",
    );
    expect(browserScreencastAsClient.ok).toBe(false);

    const terminalAsClient = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      newGuiManifest,
      openAckManifest,
      "client",
      "terminal.subscribe",
    );
    expect(terminalAsClient.ok).toBe(true);
  });
});
