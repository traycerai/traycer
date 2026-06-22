import { describe, expect, it } from "vitest";
import {
  notificationsSubscribeClientFrameSchema,
  notificationsSubscribeServerFrameSchema,
  notificationsSubscribeV10,
} from "@traycer/protocol/host/notifications/subscribe";

/**
 * `notifications.subscribe@1.0` frame fixtures.
 *
 * Covers every frame kind the contract declares, including the binary-bearing
 * frames (`hasBinaryPayload: true`) that ride a paired binary payload and the
 * pure-text frames (`pong`, `ping`) whose `hasBinaryPayload` is pinned to the
 * `false` literal.
 */

describe("notifications.subscribe@1.0 server frames", () => {
  it("parses a binary-bearing snapshot frame with a semver schemaVersion", () => {
    const parsed = notificationsSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      meta: {
        schemaVersion: "1.0.0",
      },
      hasBinaryPayload: true,
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.meta.schemaVersion).toBe("1.0.0");
      expect(parsed.hasBinaryPayload).toBe(true);
    }
  });

  it("parses a binary-bearing update frame", () => {
    const update = notificationsSubscribeServerFrameSchema.parse({
      kind: "update",
      hasBinaryPayload: true,
    });
    expect(update.kind).toBe("update");
    expect(update.hasBinaryPayload).toBe(true);
  });

  it("parses a text-only pong frame", () => {
    const parsed = notificationsSubscribeServerFrameSchema.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("pong");
    expect(parsed.hasBinaryPayload).toBe(false);
  });

  it("rejects a pong frame that claims a binary payload", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a snapshot frame that is missing the meta envelope", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a snapshot frame with a numeric schemaVersion", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        meta: {
          schemaVersion: 1,
        },
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("notifications.subscribe@1.0 client frames", () => {
  it("parses a binary-bearing applyUpdate frame", () => {
    const applyUpdate = notificationsSubscribeClientFrameSchema.parse({
      kind: "applyUpdate",
      hasBinaryPayload: true,
    });
    expect(applyUpdate.kind).toBe("applyUpdate");
    expect(applyUpdate.hasBinaryPayload).toBe(true);
  });

  it("parses a text-only ping frame", () => {
    const parsed = notificationsSubscribeClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("ping");
    expect(parsed.hasBinaryPayload).toBe(false);
  });
});

describe("notifications.subscribe@1.0 open request", () => {
  it("accepts an empty object", () => {
    const parsed = notificationsSubscribeV10.openRequestSchema.parse({});
    expect(parsed).toEqual({});
  });
});
