import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  chatAutoArchiveGetV10,
  chatAutoArchiveSetV10,
} from "@traycer/protocol/host/chat-auto-archive/contracts";

/**
 * `chatAutoArchive.get` / `chatAutoArchive.set` are optional capabilities.
 * Neither may enter the released floor: the floor is fail-closed on the
 * method-name union, so a name present on only one peer would make the whole
 * connection incompatible. Construction (`defineRpcContract`) is
 * structural-only and does not walk schemas; the schema-compatibility pass
 * is the explicit `validateVersionedRpcRegistry` call below.
 */

const POLICY = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 86_400,
  updatedAt: 1_700_000_000_000,
};

const BOUNDS = {
  minSeconds: 60,
  maxSeconds: 2_592_000,
};

const SET_REQUEST = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 86_400,
};

const RESPONSE = {
  policy: POLICY,
  bounds: BOUNDS,
};

describe("chat-auto-archive protocol contracts", () => {
  it("parses a valid get request, set request, and shared response", () => {
    expect(chatAutoArchiveGetV10.requestSchema.parse({})).toEqual({});
    expect(chatAutoArchiveSetV10.requestSchema.parse(SET_REQUEST)).toEqual(
      SET_REQUEST,
    );
    expect(chatAutoArchiveGetV10.responseSchema.parse(RESPONSE)).toEqual(
      RESPONSE,
    );
    expect(chatAutoArchiveSetV10.responseSchema.parse(RESPONSE)).toEqual(
      RESPONSE,
    );
  });

  it("rejects a zero, negative, or non-integer idleSeconds on the set request", () => {
    // Bounds are host data, not schema ceilings; the wire only requires a
    // positive integer.
    for (const idleSeconds of [0, -1, 1.5]) {
      expect(
        chatAutoArchiveSetV10.requestSchema.safeParse({
          ...SET_REQUEST,
          idleSeconds,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a null policy and rejects a null root or missing bounds", () => {
    // Nullable member of an object root, never a nullable root, so the
    // response can grow additively.
    const neverSaved = { policy: null, bounds: BOUNDS };
    expect(chatAutoArchiveGetV10.responseSchema.parse(neverSaved)).toEqual(
      neverSaved,
    );
    expect(chatAutoArchiveSetV10.responseSchema.parse(neverSaved)).toEqual(
      neverSaved,
    );
    expect(chatAutoArchiveGetV10.responseSchema.safeParse(null).success).toBe(
      false,
    );
    expect(
      chatAutoArchiveGetV10.responseSchema.safeParse({ policy: null }).success,
    ).toBe(false);
  });

  it("names both methods at { major: 1, minor: 0 }", () => {
    expect(chatAutoArchiveGetV10.method).toBe("chatAutoArchive.get");
    expect(chatAutoArchiveSetV10.method).toBe("chatAutoArchive.set");
    expect(chatAutoArchiveGetV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(chatAutoArchiveSetV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("registers both methods off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();

    for (const method of [
      "chatAutoArchive.get",
      "chatAutoArchive.set",
    ] as const) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
    }

    expect(
      hostRpcRegistry["chatAutoArchive.get"][1].versions[0].contract,
    ).toBe(chatAutoArchiveGetV10);
    expect(
      hostRpcRegistry["chatAutoArchive.set"][1].versions[0].contract,
    ).toBe(chatAutoArchiveSetV10);
  });
});
