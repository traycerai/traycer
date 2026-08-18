import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  terminalPlainCloseV10,
  terminalPlainCreateV10,
  terminalPlainEnsureRunningV10,
  terminalPlainImportLegacyV10,
  terminalPlainListV10,
  terminalPlainRenameV10,
} from "@traycer/protocol/host/terminal/plain-contracts";
import {
  closePlainTerminalRequestSchema,
  createPlainTerminalRequestSchema,
  createPlainTerminalResponseSchema,
  ensurePlainTerminalRunningRequestSchema,
  ensurePlainTerminalRunningResponseSchema,
  importLegacyPlainTerminalRequestSchema,
  importLegacyPlainTerminalResponseSchema,
  listPlainTerminalsRequestSchema,
  listPlainTerminalsResponseSchema,
  plainTerminalProjectionSchema,
  renamePlainTerminalRequestSchema,
  type PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  terminalPlainSubscribeListClientFrameSchema,
  terminalPlainSubscribeListOpenRequestSchema,
  terminalPlainSubscribeListServerFrameSchema,
  terminalPlainSubscribeListV10,
} from "@traycer/protocol/host/terminal/plain-subscribe-list";
import {
  terminalCreateV10,
  terminalCreateV20,
  terminalListV10,
  terminalListV20,
  terminalListV21,
  terminalListV22,
  terminalRenameV10,
} from "@traycer/protocol/host/terminal/contracts";

function terminal(
  runtime: PlainTerminalProjection["runtime"],
  scope: PlainTerminalProjection["record"]["scope"],
): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: "host-1",
      scope,
      launch: {
        cwd: "/workspace/project",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: "Build shell",
      revision: 7,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:05:00.000Z",
    },
    runtime,
  };
}

const epicScope = { kind: "epic", epicId: "epic-1" } as const;
const dormant = terminal({ status: "dormant" }, epicScope);
const running = terminal(
  {
    status: "running",
    sessionId: "terminal-1",
    currentCwd: "/workspace/project/packages/app",
    activeProcessName: "bun",
    cols: 120,
    rows: 40,
  },
  epicScope,
);

describe("durable plain-terminal projections", () => {
  it("parses epic and independent records with dormant or running runtimes", () => {
    expect(plainTerminalProjectionSchema.parse(dormant)).toEqual(dormant);
    expect(plainTerminalProjectionSchema.parse(running)).toEqual(running);

    const independent = terminal(
      { status: "dormant" },
      { kind: "independent" },
    );
    expect(plainTerminalProjectionSchema.parse(independent)).toEqual(
      independent,
    );
    expect(
      listPlainTerminalsResponseSchema.parse({
        terminals: [dormant, running, independent],
      }).terminals,
    ).toHaveLength(3);
  });

  it("keeps manual title and live foreground process as independent fields", () => {
    const parsed = plainTerminalProjectionSchema.parse(running);
    expect(parsed.record.manualTitle).toBe("Build shell");
    expect(parsed.runtime).toMatchObject({
      status: "running",
      activeProcessName: "bun",
    });
  });

  it("enforces sessionId equality with the logical terminalId", () => {
    expect(
      plainTerminalProjectionSchema.safeParse({
        ...running,
        runtime: { ...running.runtime, sessionId: "other-runtime" },
      }).success,
    ).toBe(false);
  });
});

describe("host-authoritative request boundaries", () => {
  const createRequest = {
    terminalId: "terminal-1",
    scope: { kind: "epic" as const, epicId: "epic-1" },
    cwd: "/workspace/project",
    cols: 80,
    rows: 24,
  };

  it("accepts only the client inputs needed to create a logical terminal", () => {
    expect(createPlainTerminalRequestSchema.parse(createRequest)).toEqual(
      createRequest,
    );
  });

  it.each([
    ["owner identity", { ownerUserId: "user-2" }],
    ["environment", { env: { TOKEN: "secret" } }],
    ["resolved shell command", { shellCommand: "/tmp/client-shell" }],
    ["resolved shell arguments", { shellArgs: ["--client-selected"] }],
    ["host identity", { hostId: "other-host" }],
  ])("rejects client-supplied %s", (_label, extra) => {
    expect(
      createPlainTerminalRequestSchema.safeParse({
        ...createRequest,
        ...extra,
      }).success,
    ).toBe(false);
  });

  it("rejects authority fields hidden inside scope", () => {
    expect(
      createPlainTerminalRequestSchema.safeParse({
        ...createRequest,
        scope: {
          ...createRequest.scope,
          ownerUserId: "user-2",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded legacy evidence but rejects resolved launch data", () => {
    const request = {
      terminalId: "legacy-1",
      hostId: "host-1",
      scope: { kind: "independent" as const },
      cwd: "/workspace/legacy",
      name: "Legacy shell",
      titleSource: "manual" as const,
      sourceStoreVersion: 1,
    };
    expect(importLegacyPlainTerminalRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      importLegacyPlainTerminalRequestSchema.safeParse({
        ...request,
        shellCommand: "/bin/fish",
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "list",
      listPlainTerminalsRequestSchema,
      { scope: { kind: "independent" as const } },
    ],
    [
      "rename",
      renamePlainTerminalRequestSchema,
      { terminalId: "terminal-1", manualTitle: "Build shell" },
    ],
    [
      "ensure-running",
      ensurePlainTerminalRunningRequestSchema,
      { terminalId: "terminal-1", cols: 120, rows: 40 },
    ],
    ["close", closePlainTerminalRequestSchema, { terminalId: "terminal-1" }],
  ])("parses a valid %s request", (_label, schema, request) => {
    expect(schema.parse(request)).toEqual(request);
  });

  it.each([
    [
      "list",
      listPlainTerminalsRequestSchema,
      { scope: { kind: "independent" }, ownerUserId: "user-2" },
    ],
    [
      "rename",
      renamePlainTerminalRequestSchema,
      {
        terminalId: "terminal-1",
        manualTitle: null,
        activeProcessName: "bun",
      },
    ],
    [
      "ensure-running",
      ensurePlainTerminalRunningRequestSchema,
      { terminalId: "terminal-1", cols: 120, rows: 40, cwd: "/tmp" },
    ],
    [
      "close",
      closePlainTerminalRequestSchema,
      { terminalId: "terminal-1", revision: 7 },
    ],
  ])("rejects extra fields on a %s request", (_label, schema, request) => {
    expect(schema.safeParse(request).success).toBe(false);
  });

  it.each([
    ["list", listPlainTerminalsRequestSchema, {}],
    ["rename", renamePlainTerminalRequestSchema, { terminalId: "terminal-1" }],
    [
      "ensure-running",
      ensurePlainTerminalRunningRequestSchema,
      { terminalId: "terminal-1", cols: 0, rows: 40 },
    ],
    ["close", closePlainTerminalRequestSchema, { terminalId: "" }],
  ])("rejects a malformed %s request", (_label, schema, request) => {
    expect(schema.safeParse(request).success).toBe(false);
  });
});

describe("running-only mutation responses", () => {
  it.each([
    ["create", createPlainTerminalResponseSchema],
    ["ensure-running", ensurePlainTerminalRunningResponseSchema],
  ])("accepts a running %s response", (_label, schema) => {
    expect(schema.parse({ terminal: running })).toEqual({ terminal: running });
  });

  it.each([
    ["create", createPlainTerminalResponseSchema],
    ["ensure-running", ensurePlainTerminalRunningResponseSchema],
  ])("rejects a dormant %s response", (_label, schema) => {
    expect(schema.safeParse({ terminal: dormant }).success).toBe(false);
  });
});

describe("legacy import outcomes", () => {
  it.each(["imported", "existing"] as const)(
    "returns the canonical host projection for %s",
    (status) => {
      expect(
        importLegacyPlainTerminalResponseSchema.parse({
          status,
          terminal: dormant,
        }),
      ).toEqual({ status, terminal: dormant });
    },
  );

  it("represents a previously deleted id without a record", () => {
    const deleted = {
      status: "deleted" as const,
      terminalId: "terminal-1",
      revision: 8,
    };
    expect(importLegacyPlainTerminalResponseSchema.parse(deleted)).toEqual(
      deleted,
    );
    expect(
      importLegacyPlainTerminalResponseSchema.safeParse({
        ...deleted,
        terminal: dormant,
      }).success,
    ).toBe(false);
  });
});

describe("plain-terminal collection frames", () => {
  it("strictly parses epic and independent stream open requests", () => {
    const requests = [
      { scope: { kind: "epic" as const, epicId: "epic-1" } },
      { scope: { kind: "independent" as const } },
    ];
    for (const request of requests) {
      expect(
        terminalPlainSubscribeListOpenRequestSchema.parse(request),
      ).toEqual(request);
    }
    expect(
      terminalPlainSubscribeListOpenRequestSchema.safeParse({
        scope: { kind: "independent" },
        ownerUserId: "user-2",
      }).success,
    ).toBe(false);
    expect(
      terminalPlainSubscribeListOpenRequestSchema.safeParse({
        scope: { kind: "epic", epicId: "" },
      }).success,
    ).toBe(false);
  });

  it("parses the client ping and rejects malformed client frames", () => {
    const ping = { kind: "ping" as const, hasBinaryPayload: false as const };
    expect(terminalPlainSubscribeListClientFrameSchema.parse(ping)).toEqual(
      ping,
    );
    for (const malformed of [
      { kind: "ping", hasBinaryPayload: true },
      { kind: "ping", hasBinaryPayload: false, extra: true },
      { kind: "ack", hasBinaryPayload: false },
    ]) {
      expect(
        terminalPlainSubscribeListClientFrameSchema.safeParse(malformed)
          .success,
      ).toBe(false);
    }
  });

  it("parses snapshot, initialization, upsert, revisioned deletion, and pong frames", () => {
    const frames = [
      {
        kind: "initialized" as const,
        hasBinaryPayload: false as const,
      },
      {
        kind: "snapshot" as const,
        hasBinaryPayload: false as const,
        terminals: [dormant, running],
      },
      {
        kind: "upsert" as const,
        hasBinaryPayload: false as const,
        terminal: running,
      },
      {
        kind: "deleted" as const,
        hasBinaryPayload: false as const,
        terminalId: "terminal-1",
        revision: 8,
      },
      {
        kind: "pong" as const,
        hasBinaryPayload: false as const,
      },
    ];
    for (const frame of frames) {
      expect(terminalPlainSubscribeListServerFrameSchema.parse(frame)).toEqual(
        frame,
      );
    }
  });

  it("rejects deletion frames that smuggle a stopped terminal record", () => {
    expect(
      terminalPlainSubscribeListServerFrameSchema.safeParse({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 8,
        terminal: dormant,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["snapshot", { kind: "snapshot", hasBinaryPayload: false }],
    ["upsert", { kind: "upsert", hasBinaryPayload: false }],
    [
      "initialized",
      { kind: "initialized", hasBinaryPayload: false, extra: true },
    ],
    [
      "deleted",
      {
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: -1,
      },
    ],
    ["pong", { kind: "pong", hasBinaryPayload: false, revision: 1 }],
    [
      "binary snapshot",
      { kind: "snapshot", hasBinaryPayload: true, terminals: [dormant] },
    ],
    ["unknown", { kind: "reset", hasBinaryPayload: false }],
  ])("rejects a malformed %s server frame", (_label, frame) => {
    expect(
      terminalPlainSubscribeListServerFrameSchema.safeParse(frame).success,
    ).toBe(false);
  });
});

describe("protocol registration and released compatibility", () => {
  it("registers every unary contract as an optional initial version", () => {
    const expected = {
      "terminal.plain.create": terminalPlainCreateV10,
      "terminal.plain.list": terminalPlainListV10,
      "terminal.plain.rename": terminalPlainRenameV10,
      "terminal.plain.ensureRunning": terminalPlainEnsureRunningV10,
      "terminal.plain.close": terminalPlainCloseV10,
      "terminal.plain.importLegacy": terminalPlainImportLegacyV10,
    } as const;

    for (const [method, contract] of Object.entries(expected)) {
      const entry = hostRpcRegistry[method as keyof typeof expected];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].versions[0].contract).toBe(contract);
    }
  });

  it("registers the snapshot-first list stream", () => {
    expect(
      hostStreamRpcRegistry["terminal.plain.subscribeList"][1].versions[0]
        .contract,
    ).toBe(terminalPlainSubscribeListV10);
  });

  it("leaves all released generic terminal version lines frozen", () => {
    expect(hostRpcRegistry["terminal.create"][1].versions[0].contract).toBe(
      terminalCreateV10,
    );
    expect(hostRpcRegistry["terminal.create"][2].versions[0].contract).toBe(
      terminalCreateV20,
    );
    expect(hostRpcRegistry["terminal.list"][1].versions[0].contract).toBe(
      terminalListV10,
    );
    expect(hostRpcRegistry["terminal.list"][2].versions[0].contract).toBe(
      terminalListV20,
    );
    expect(hostRpcRegistry["terminal.list"][2].versions[1].contract).toBe(
      terminalListV21,
    );
    expect(hostRpcRegistry["terminal.list"][2].versions[2].contract).toBe(
      terminalListV22,
    );
    expect(hostRpcRegistry["terminal.rename"][1].versions[0].contract).toBe(
      terminalRenameV10,
    );
  });
});
