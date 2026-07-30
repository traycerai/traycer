import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  AGENT_ACTIVITY_AWARENESS_FIELD,
  AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD,
  notificationsSubscribeClientFrameSchema,
  notificationsSubscribeServerFrameSchema,
  notificationsSubscribeServerFrameSchemaV10,
  notificationsSubscribeServerFrameSchemaV11,
  notificationsSubscribeV10,
  notificationsSubscribeV11,
} from "@traycer/protocol/host/notifications/subscribe";

/**
 * `notifications.subscribe@1.0` / `@1.1` frame fixtures.
 *
 * Covers every frame kind the contract declares, including the binary-bearing
 * frames (`hasBinaryPayload: true`) that ride a paired binary payload and the
 * pure-text frames (`pong`, `ping`) whose `hasBinaryPayload` is pinned to the
 * `false` literal.
 */

describe("notifications.subscribe@1.0 server frames", () => {
  it("parses a binary-bearing snapshot frame with a semver schemaVersion", () => {
    const parsed = notificationsSubscribeServerFrameSchemaV10.parse({
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
    const update = notificationsSubscribeServerFrameSchemaV10.parse({
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
      notificationsSubscribeServerFrameSchemaV10.parse({
        kind: "pong",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a snapshot frame that is missing the meta envelope", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchemaV10.parse({
        kind: "snapshot",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a snapshot frame with a numeric schemaVersion", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchemaV10.parse({
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

describe("notifications.subscribe@1.1 awareness frame", () => {
  it("parses a binary-bearing awareness frame", () => {
    const parsed = notificationsSubscribeServerFrameSchemaV11.parse({
      kind: "awareness",
      hasBinaryPayload: true,
    });

    expect(parsed.kind).toBe("awareness");
    expect(parsed.hasBinaryPayload).toBe(true);
  });

  it("rejects an awareness frame that claims no binary payload", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchemaV11.parse({
        kind: "awareness",
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("keeps the @1.0 union frozen against the new frame kind", () => {
    expect(() =>
      notificationsSubscribeServerFrameSchemaV10.parse({
        kind: "awareness",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("still parses every @1.0 frame kind", () => {
    expect(
      notificationsSubscribeServerFrameSchemaV11.parse({
        kind: "snapshot",
        meta: { schemaVersion: "1.0.0" },
        hasBinaryPayload: true,
      }).kind,
    ).toBe("snapshot");
    expect(
      notificationsSubscribeServerFrameSchemaV11.parse({
        kind: "update",
        hasBinaryPayload: true,
      }).kind,
    ).toBe("update");
    expect(
      notificationsSubscribeServerFrameSchemaV11.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
  });

  it("exposes @1.1 as the latest installed server-frame shape", () => {
    expect(notificationsSubscribeServerFrameSchema).toBe(
      notificationsSubscribeServerFrameSchemaV11,
    );
  });

  it("adds no client frame - the GUI only reads activity", () => {
    expect(notificationsSubscribeV11.clientFrameSchema).toBe(
      notificationsSubscribeClientFrameSchema,
    );
    expect(() =>
      notificationsSubscribeClientFrameSchema.parse({
        kind: "awareness",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("agent-activity awareness fields", () => {
  it("pins the frozen field names writer and reader share", () => {
    expect(AGENT_ACTIVITY_AWARENESS_FIELD).toBe("agentActivityByEpic");
    expect(AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD).toBe("agentActivityHostId");
  });
});

describe("notifications.subscribe registry membership", () => {
  it("installs @1.0 and @1.1 on the stream registry at major 1", () => {
    const entry = hostStreamRpcRegistry["notifications.subscribe"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(1);
    expect(entry[1].versions[0].contract).toBe(notificationsSubscribeV10);
    expect(entry[1].versions[1].contract).toBe(notificationsSubscribeV11);
    expect(notificationsSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(notificationsSubscribeV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});
