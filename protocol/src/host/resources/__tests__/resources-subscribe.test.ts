import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  resourcesSubscribeClientFrameSchema,
  resourcesSubscribeServerFrameSchema,
  resourcesSubscribeV10,
} from "@traycer/protocol/host/resources/subscribe";

/**
 * `resources.subscribe@1.0` contract fixtures + registry membership.
 *
 * Covers the open request, every server/client frame kind, and the invariant
 * that the stream method is negotiated from the combined stream registry at
 * `{ major: 1, minor: 0 }`.
 */

const PROCESS_FIXTURE = {
  pid: 42,
  parentPid: 1,
  rootPid: 42,
  name: "bash",
  command: "/bin/bash",
  cpuPercent: 12.5,
  rssBytes: 4_096,
};

const OWNER_FIXTURE = {
  owner: {
    kind: "terminal" as const,
    hostId: "host-1",
    epicId: "epic-1",
    ownerId: "session-1",
  },
  sampledAt: 1_000,
  rootPids: [42],
  activeProcessName: "vim",
  processCount: 3,
  cpuPercent: 12.5,
  rssBytes: 4_096,
  processes: [PROCESS_FIXTURE],
};

const EPIC_FIXTURE = {
  hostId: "host-1",
  epicId: "epic-1",
  sampledAt: 1_000,
  ownerCount: 1,
  processCount: 3,
  cpuPercent: 12.5,
  rssBytes: 4_096,
};

const APP_FIXTURE = {
  sampledAt: 1_000,
  hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
  process: { ...PROCESS_FIXTURE, pid: 10, rootPid: 10, name: "traycer-host" },
  processCount: 1,
  cpuPercent: 1.5,
  rssBytes: 256 * 1024 * 1024,
};

describe("resources.subscribe@1.0 open request", () => {
  it("requires an epicId", () => {
    expect(
      resourcesSubscribeV10.openRequestSchema.parse({ epicId: "epic-1" }),
    ).toEqual({ epicId: "epic-1" });
    expect(() => resourcesSubscribeV10.openRequestSchema.parse({})).toThrow();
  });
});

describe("resources.subscribe@1.0 server frames", () => {
  it("parses a snapshot frame carrying owners and an epic aggregate", () => {
    const parsed = resourcesSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      sampledAt: 1_000,
      app: APP_FIXTURE,
      owners: [OWNER_FIXTURE],
      epic: EPIC_FIXTURE,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.app?.process?.name).toBe("traycer-host");
      expect(parsed.owners).toHaveLength(1);
      expect(parsed.owners[0].processes[0].name).toBe("bash");
      expect(parsed.epic?.epicId).toBe("epic-1");
    }
  });

  it("parses an update frame with an empty epic (null aggregate)", () => {
    const parsed = resourcesSubscribeServerFrameSchema.parse({
      kind: "update",
      epicId: "epic-1",
      sampledAt: 0,
      app: null,
      owners: [],
      epic: null,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("update");
    if (parsed.kind === "update") {
      expect(parsed.owners).toEqual([]);
      expect(parsed.epic).toBeNull();
    }
  });

  it("accepts a null activeProcessName on an owner snapshot", () => {
    const parsed = resourcesSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      sampledAt: 1_000,
      app: APP_FIXTURE,
      owners: [{ ...OWNER_FIXTURE, activeProcessName: null }],
      epic: EPIC_FIXTURE,
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.owners[0].activeProcessName).toBeNull();
  });

  it("parses a text-only pong frame", () => {
    const parsed = resourcesSubscribeServerFrameSchema.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("pong");
  });

  it("rejects a snapshot frame that claims a binary payload", () => {
    expect(() =>
      resourcesSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        epicId: "epic-1",
        sampledAt: 1_000,
        app: null,
        owners: [],
        epic: null,
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects an owner with an unknown kind", () => {
    expect(() =>
      resourcesSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        epicId: "epic-1",
        sampledAt: 1_000,
        app: null,
        owners: [
          { ...OWNER_FIXTURE, owner: { ...OWNER_FIXTURE.owner, kind: "plan" } },
        ],
        epic: null,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("rejects negative aggregate RSS values", () => {
    expect(() =>
      resourcesSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        epicId: "epic-1",
        sampledAt: 1_000,
        app: null,
        owners: [{ ...OWNER_FIXTURE, rssBytes: -1 }],
        epic: null,
        hasBinaryPayload: false,
      }),
    ).toThrow();

    expect(() =>
      resourcesSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        epicId: "epic-1",
        sampledAt: 1_000,
        app: null,
        owners: [],
        epic: { ...EPIC_FIXTURE, rssBytes: -1 },
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });
});

describe("resources.subscribe@1.0 client frames", () => {
  it("parses a text-only ping frame", () => {
    const parsed = resourcesSubscribeClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("ping");
  });
});

describe("resources.subscribe@1.0 registry membership", () => {
  it("is registered on the stream registry at major 1 / minor 0", () => {
    const entry = hostStreamRpcRegistry["resources.subscribe"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(resourcesSubscribeV10);
    expect(resourcesSubscribeV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });
});
