import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  ownerResourceSnapshotSchemaV13,
  resourcesKillRequestSchema,
  resourcesKillResponseSchema,
  resourcesKillV10,
  resourcesSubscribeClientFrameSchema,
  resourcesSubscribeOpenRequestV11Schema,
  resourcesSubscribeServerFrameSchema,
  resourcesSubscribeServerFrameSchemaV12,
  resourcesSubscribeServerFrameSchemaV13,
  resourcesSubscribeV10,
  resourcesSubscribeV11,
  resourcesSubscribeV12,
  resourcesSubscribeV13,
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

const HOST_TREE_FIXTURE = {
  sampledAt: 1_000,
  processCount: 5,
  cpuPercent: 21.5,
  rssBytes: 512 * 1024 * 1024,
};

const OTHER_FIXTURE = {
  sampledAt: 1_000,
  rootPids: [99],
  processCount: 2,
  cpuPercent: 8.5,
  rssBytes: 128 * 1024 * 1024,
  processes: [
    {
      ...PROCESS_FIXTURE,
      pid: 99,
      rootPid: 99,
      name: "shared-provider",
    },
  ],
};

describe("resources.subscribe@1.0 open request", () => {
  it("requires an epicId", () => {
    expect(
      resourcesSubscribeV10.openRequestSchema.parse({ epicId: "epic-1" }),
    ).toEqual({ epicId: "epic-1" });
    expect(() => resourcesSubscribeV10.openRequestSchema.parse({})).toThrow();
  });
});

describe("resources.subscribe@1.1 open request", () => {
  it("accepts an explicit global scope", () => {
    expect(
      resourcesSubscribeOpenRequestV11Schema.parse({
        epicId: "__global__",
        scope: { kind: "global" },
      }),
    ).toEqual({
      epicId: "__global__",
      scope: { kind: "global" },
    });
  });

  it("accepts an explicit epic scope", () => {
    expect(
      resourcesSubscribeOpenRequestV11Schema.parse({
        epicId: "epic-1",
        scope: { kind: "epic", epicId: "epic-1" },
      }),
    ).toEqual({
      epicId: "epic-1",
      scope: { kind: "epic", epicId: "epic-1" },
    });
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

  it("parses a global snapshot frame carrying all epic aggregates", () => {
    const parsed = resourcesSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "__global__",
      sampledAt: 1_000,
      app: APP_FIXTURE,
      owners: [OWNER_FIXTURE],
      epic: EPIC_FIXTURE,
      epics: [EPIC_FIXTURE, { ...EPIC_FIXTURE, epicId: "epic-2" }],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.epics?.map((entry) => entry.epicId)).toEqual([
      "epic-1",
      "epic-2",
    ]);
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

describe("resources.subscribe@1.2 server frames", () => {
  it("carries the host-tree aggregate and Other process self snapshots", () => {
    const parsed = resourcesSubscribeServerFrameSchemaV12.parse({
      kind: "snapshot",
      epicId: "__global__",
      sampledAt: 1_000,
      app: APP_FIXTURE,
      owners: [OWNER_FIXTURE],
      epic: null,
      epics: [EPIC_FIXTURE],
      hostTree: HOST_TREE_FIXTURE,
      other: OTHER_FIXTURE,
      hasBinaryPayload: false,
    });

    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.hostTree).toEqual(HOST_TREE_FIXTURE);
    expect(parsed.other?.rootPids).toEqual([99]);
    expect(parsed.other?.processes[0]).toMatchObject({
      pid: 99,
      parentPid: 1,
      rootPid: 99,
      name: "shared-provider",
      command: "/bin/bash",
      cpuPercent: 12.5,
      rssBytes: 4_096,
    });
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
    expect(entry[1].latestMinor).toBe(3);
    expect(entry[1].versions[0].contract).toBe(resourcesSubscribeV10);
    expect(entry[1].versions[1].contract).toBe(resourcesSubscribeV11);
    expect(entry[1].versions[2].contract).toBe(resourcesSubscribeV12);
    expect(entry[1].versions[3].contract).toBe(resourcesSubscribeV13);
    expect(resourcesSubscribeV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(resourcesSubscribeV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(resourcesSubscribeV12.schemaVersion).toEqual({ major: 1, minor: 2 });
    expect(resourcesSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
  });
});

describe("resources.subscribe@1.3 owner harnessId", () => {
  it("adds a nullable harnessId to the owner snapshot, frozen prior minors", () => {
    const owner = {
      kind: "chat" as const,
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "chat-1",
    };
    const base = {
      owner,
      sampledAt: 1,
      rootPids: [10],
      activeProcessName: null,
      processCount: 1,
      cpuPercent: 0,
      rssBytes: 0,
      processes: [],
    };
    expect(
      ownerResourceSnapshotSchemaV13.parse({ ...base, harnessId: "claude" })
        .harnessId,
    ).toBe("claude");
    expect(
      ownerResourceSnapshotSchemaV13.parse({ ...base, harnessId: null })
        .harnessId,
    ).toBeNull();
    // The frozen `@1.2` frame strips `harnessId` from its owner shape (Zod
    // drops unknown object keys), proving a pre-`@1.3` client never surfaces it.
    const framedV12 = resourcesSubscribeServerFrameSchemaV12.parse({
      kind: "snapshot",
      epicId: "epic-1",
      sampledAt: 1,
      app: null,
      owners: [{ ...base, harnessId: "codex" }],
      hostTree: null,
      other: null,
      epic: null,
      hasBinaryPayload: false,
    });
    expect(framedV12.kind).toBe("snapshot");
    if (framedV12.kind !== "snapshot") throw new Error("expected snapshot");
    expect(framedV12.owners[0]).not.toHaveProperty("harnessId");
    // `@1.3` keeps it.
    const framedV13 = resourcesSubscribeServerFrameSchemaV13.parse({
      kind: "snapshot",
      epicId: "epic-1",
      sampledAt: 1,
      app: null,
      owners: [{ ...base, harnessId: "codex" }],
      hostTree: null,
      other: null,
      epic: null,
      hasBinaryPayload: false,
    });
    expect(framedV13.kind).toBe("snapshot");
    if (framedV13.kind !== "snapshot") throw new Error("expected snapshot");
    expect(framedV13.owners[0].harnessId).toBe("codex");
  });
});

describe("resources.kill@1.0 registry membership", () => {
  it("is registered as a brand-new unary method that degrades unsupported", () => {
    const entry = hostRpcRegistry["resources.kill"];
    expect(entry).toBeDefined();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].versions[0].contract).toBe(resourcesKillV10);
    expect(resourcesKillV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(
      resourcesKillRequestSchema.parse({ pids: [1, 2, 3] }).pids,
    ).toEqual([1, 2, 3]);
    expect(resourcesKillResponseSchema.parse({ killed: [1] }).killed).toEqual([
      1,
    ]);
  });
});
