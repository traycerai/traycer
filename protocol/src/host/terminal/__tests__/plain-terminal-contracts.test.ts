import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  PLAIN_TERMINAL_FAMILY_METHODS,
  PLAIN_TERMINAL_FAMILY_VERSION,
  PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  resolvePlainTerminalFamilyCapability,
  terminalPlainCloseV10,
  terminalPlainCloseV21,
  terminalPlainCreateV10,
  terminalPlainCreateV21,
  terminalPlainEnsureRunningV10,
  terminalPlainEnsureRunningV21,
  terminalPlainImportLegacyV10,
  terminalPlainImportLegacyV21,
  terminalPlainListV10,
  terminalPlainListV21,
  terminalPlainRenameV10,
  terminalPlainRenameV21,
  type PlainTerminalFamilyMethod,
} from "@traycer/protocol/host/terminal/plain-contracts";
import {
  closePlainTerminalRequestSchema,
  closePlainTerminalResponseSchema,
  createPlainTerminalRequestSchema,
  createPlainTerminalResponseSchema,
  ensurePlainTerminalRunningRequestSchema,
  ensurePlainTerminalRunningResponseSchema,
  importLegacyPlainTerminalRequestSchema,
  importLegacyPlainTerminalResponseSchema,
  listPlainTerminalsRequestSchema,
  listPlainTerminalsResponseSchema,
  plainTerminalFleetIdentity,
  plainTerminalFleetIdentityKey,
  plainTerminalListStateSchema,
  plainTerminalProjectionSchema,
  renamePlainTerminalRequestSchema,
  type PlainTerminalFleetIdentity,
  type PlainTerminalListState,
  type PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  terminalPlainSubscribeListClientFrameSchemaV10,
  terminalPlainSubscribeListServerFrameSchemaV10,
  terminalPlainSubscribeListV10,
  terminalPlainSubscribeListClientFrameSchema,
  terminalPlainSubscribeListOpenRequestSchema,
  terminalPlainSubscribeListServerFrameSchema,
  terminalPlainSubscribeListV21,
} from "@traycer/protocol/host/terminal/plain-subscribe-list";
import {
  terminalCreateV10,
  terminalCreateV20,
  terminalListV10,
  terminalListV20,
  terminalListV21,
  terminalListV22,
  terminalListV23,
  terminalRenameV10,
} from "@traycer/protocol/host/terminal/contracts";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersionWithContext,
  type SchemaVersion as FrameworkSchemaVersion,
} from "@traycer/protocol/framework/index";

function terminal(
  runtime: PlainTerminalProjection["runtime"],
  scope: PlainTerminalProjection["record"]["scope"],
  hostId: string,
  terminalId: string,
): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId,
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
const independentScope = { kind: "independent" } as const;
const dormant = terminal(
  { status: "dormant" },
  epicScope,
  "host-1",
  "terminal-1",
);
const unknown = terminal(
  { status: "unknown" },
  epicScope,
  "host-2",
  "terminal-unknown",
);
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
  "host-1",
  "terminal-1",
);
const independent = terminal(
  { status: "dormant" },
  independentScope,
  "host-1",
  "terminal-1",
);
const remote = terminal(
  { status: "dormant" },
  epicScope,
  "host-2",
  "terminal-2",
);

const completeFleet: PlainTerminalListState = {
  coverage: "complete-fleet",
  scope: epicScope,
  terminals: [dormant, remote],
};

const partialServingHost: PlainTerminalListState = {
  coverage: "partial-serving-host",
  scope: epicScope,
  servingHostId: "host-1",
  terminals: [running],
};

const completeLocal: PlainTerminalListState = {
  coverage: "complete-local",
  scope: independentScope,
  terminals: [independent],
};

function familyCapability(
  versions: Readonly<Record<string, FrameworkSchemaVersion>>,
  manifestKnown: boolean,
) {
  return resolvePlainTerminalFamilyCapability({
    manifestKnown,
    versionFor: (method) => versions[method] ?? null,
  });
}

const V2_FAMILY = Object.fromEntries(
  PLAIN_TERMINAL_FAMILY_METHODS.map((method) => [
    method,
    { major: 2, minor: 1 },
  ]),
) as Record<PlainTerminalFamilyMethod, FrameworkSchemaVersion>;
const V1_FAMILY = Object.fromEntries(
  PLAIN_TERMINAL_FAMILY_METHODS.map((method) => [
    method,
    { major: 1, minor: 0 },
  ]),
) as Record<PlainTerminalFamilyMethod, FrameworkSchemaVersion>;

describe("durable plain-terminal projections", () => {
  it("parses records with unknown, dormant, or running runtimes", () => {
    expect(plainTerminalProjectionSchema.parse(unknown)).toEqual(unknown);
    expect(plainTerminalProjectionSchema.parse(dormant)).toEqual(dormant);
    expect(plainTerminalProjectionSchema.parse(running)).toEqual(running);
    expect(plainTerminalProjectionSchema.parse(independent)).toEqual(
      independent,
    );
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

  it("rejects a projection whose record omits hostId", () => {
    const { hostId: _hostId, ...recordWithoutHostId } = dormant.record;
    expect(
      plainTerminalProjectionSchema.safeParse({
        ...dormant,
        record: recordWithoutHostId,
      }).success,
    ).toBe(false);
  });

  it("keys fleet identity by (hostId, terminalId)", () => {
    expect(plainTerminalFleetIdentity(dormant.record)).toEqual({
      hostId: "host-1",
      terminalId: "terminal-1",
    });
    expect(
      plainTerminalFleetIdentityKey(plainTerminalFleetIdentity(dormant.record)),
    ).not.toBe(
      plainTerminalFleetIdentityKey(plainTerminalFleetIdentity(remote.record)),
    );
    expect(
      plainTerminalFleetIdentityKey(
        plainTerminalFleetIdentity(
          terminal({ status: "dormant" }, epicScope, "host-2", "terminal-1")
            .record,
        ),
      ),
    ).not.toBe(
      plainTerminalFleetIdentityKey(plainTerminalFleetIdentity(dormant.record)),
    );
  });

  it("does not collide on identifiers containing NUL, quotes, or backslashes", () => {
    const pairs: readonly (readonly [
      PlainTerminalFleetIdentity,
      PlainTerminalFleetIdentity,
    ])[] = [
      [
        { hostId: "a\u0000b", terminalId: "c" },
        { hostId: "a", terminalId: "b\u0000c" },
      ],
      [
        { hostId: 'a","b', terminalId: "c" },
        { hostId: "a", terminalId: 'b","c' },
      ],
      [
        { hostId: "a\\", terminalId: "b" },
        { hostId: "a", terminalId: "\\b" },
      ],
    ];
    for (const [left, right] of pairs) {
      expect(plainTerminalFleetIdentityKey(left)).not.toBe(
        plainTerminalFleetIdentityKey(right),
      );
    }
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

describe("plain-terminal list state", () => {
  it("parses complete-fleet, partial-serving-host, and complete-local states", () => {
    expect(plainTerminalListStateSchema.parse(completeFleet)).toEqual(
      completeFleet,
    );
    expect(plainTerminalListStateSchema.parse(partialServingHost)).toEqual(
      partialServingHost,
    );
    expect(plainTerminalListStateSchema.parse(completeLocal)).toEqual(
      completeLocal,
    );
    expect(listPlainTerminalsResponseSchema.parse(completeFleet)).toEqual(
      completeFleet,
    );
  });

  it("treats an empty complete fleet as distinct from an empty partial view", () => {
    const emptyComplete = {
      coverage: "complete-fleet" as const,
      scope: epicScope,
      terminals: [],
    };
    const emptyPartial = {
      coverage: "partial-serving-host" as const,
      scope: epicScope,
      servingHostId: "host-1",
      terminals: [],
    };
    expect(plainTerminalListStateSchema.parse(emptyComplete)).toEqual(
      emptyComplete,
    );
    expect(plainTerminalListStateSchema.parse(emptyPartial)).toEqual(
      emptyPartial,
    );
    expect(emptyComplete).not.toEqual(emptyPartial);
  });

  it("rejects the superseded unqualified terminals array", () => {
    expect(
      listPlainTerminalsResponseSchema.safeParse({
        terminals: [dormant, running],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "complete-fleet with independent scope",
      {
        coverage: "complete-fleet",
        scope: independentScope,
        terminals: [],
      },
    ],
    [
      "complete-local with epic scope",
      {
        coverage: "complete-local",
        scope: epicScope,
        terminals: [],
      },
    ],
    [
      "partial-serving-host with independent scope",
      {
        coverage: "partial-serving-host",
        scope: independentScope,
        servingHostId: "host-1",
        terminals: [],
      },
    ],
    [
      "partial-serving-host without servingHostId",
      {
        coverage: "partial-serving-host",
        scope: epicScope,
        terminals: [running],
      },
    ],
    [
      "complete-fleet with servingHostId",
      {
        coverage: "complete-fleet",
        scope: epicScope,
        servingHostId: "host-1",
        terminals: [dormant],
      },
    ],
    [
      "unknown coverage",
      {
        coverage: "degraded",
        scope: epicScope,
        terminals: [],
      },
    ],
  ])("rejects %s", (_label, state) => {
    expect(plainTerminalListStateSchema.safeParse(state).success).toBe(false);
  });

  it("rejects a complete-fleet row whose scope does not match the state", () => {
    expect(
      plainTerminalListStateSchema.safeParse({
        coverage: "complete-fleet",
        scope: epicScope,
        terminals: [independent],
      }).success,
    ).toBe(false);
  });

  it("rejects a partial state whose rows are not the serving host", () => {
    expect(
      plainTerminalListStateSchema.safeParse({
        coverage: "partial-serving-host",
        scope: epicScope,
        servingHostId: "host-1",
        terminals: [remote],
      }).success,
    ).toBe(false);
  });

  it("rejects a list row whose record omits hostId", () => {
    const { hostId: _hostId, ...recordWithoutHostId } = dormant.record;
    expect(
      plainTerminalListStateSchema.safeParse({
        coverage: "complete-fleet",
        scope: epicScope,
        terminals: [{ ...dormant, record: recordWithoutHostId }],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "complete-fleet",
      {
        coverage: "complete-fleet" as const,
        scope: epicScope,
        terminals: [dormant, dormant],
      },
    ],
    [
      "partial-serving-host",
      {
        coverage: "partial-serving-host" as const,
        scope: epicScope,
        servingHostId: "host-1",
        terminals: [running, running],
      },
    ],
    [
      "complete-local",
      {
        coverage: "complete-local" as const,
        scope: independentScope,
        terminals: [independent, independent],
      },
    ],
  ])("rejects duplicate composite identities in a %s state", (_label, state) => {
    expect(plainTerminalListStateSchema.safeParse(state).success).toBe(false);
  });

  it("rejects duplicate identities even when the projections otherwise differ", () => {
    const renamed = terminal(
      { status: "dormant" },
      epicScope,
      "host-1",
      "terminal-1",
    );
    expect(
      plainTerminalListStateSchema.safeParse({
        coverage: "complete-fleet",
        scope: epicScope,
        terminals: [
          dormant,
          {
            ...renamed,
            record: {
              ...renamed.record,
              manualTitle: "Other title",
              revision: 9,
            },
          },
        ],
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

  it("parses replacement state frames for each coverage and the pong control frame", () => {
    const frames = [
      {
        kind: "state" as const,
        hasBinaryPayload: false as const,
        state: completeFleet,
      },
      {
        kind: "state" as const,
        hasBinaryPayload: false as const,
        state: partialServingHost,
      },
      {
        kind: "state" as const,
        hasBinaryPayload: false as const,
        state: completeLocal,
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

  it("replaces the previous collection with a later state frame of a different coverage", () => {
    const first = terminalPlainSubscribeListServerFrameSchema.parse({
      kind: "state",
      hasBinaryPayload: false,
      state: completeFleet,
    });
    const next = terminalPlainSubscribeListServerFrameSchema.parse({
      kind: "state",
      hasBinaryPayload: false,
      state: partialServingHost,
    });
    expect(first.kind === "state" ? first.state.coverage : null).toBe(
      "complete-fleet",
    );
    expect(next.kind === "state" ? next.state.coverage : null).toBe(
      "partial-serving-host",
    );
    expect(next.kind === "state" ? next.state.terminals : []).toEqual([
      running,
    ]);
  });

  it("rejects a replacement state frame with a duplicate composite identity", () => {
    expect(
      terminalPlainSubscribeListServerFrameSchema.safeParse({
        kind: "state",
        hasBinaryPayload: false,
        state: {
          coverage: "complete-fleet",
          scope: epicScope,
          terminals: [dormant, dormant],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "snapshot",
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [dormant, running],
      },
    ],
    [
      "initialized",
      { kind: "initialized", hasBinaryPayload: false },
    ],
    [
      "upsert",
      { kind: "upsert", hasBinaryPayload: false, terminal: running },
    ],
    [
      "deleted tombstone",
      {
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 8,
      },
    ],
    [
      "state without nested state",
      { kind: "state", hasBinaryPayload: false },
    ],
    [
      "state with extra field",
      {
        kind: "state",
        hasBinaryPayload: false,
        state: completeFleet,
        extra: true,
      },
    ],
    [
      "binary state",
      {
        kind: "state",
        hasBinaryPayload: true,
        state: completeFleet,
      },
    ],
    ["pong with extra", { kind: "pong", hasBinaryPayload: false, revision: 1 }],
    ["unknown", { kind: "reset", hasBinaryPayload: false }],
    [
      "state carrying invalid coverage",
      {
        kind: "state",
        hasBinaryPayload: false,
        state: {
          coverage: "complete-fleet",
          scope: independentScope,
          terminals: [],
        },
      },
    ],
  ])("rejects a malformed %s server frame", (_label, frame) => {
    expect(
      terminalPlainSubscribeListServerFrameSchema.safeParse(frame).success,
    ).toBe(false);
  });
});

describe("lifetime-delete revision", () => {
  it("keeps the close response revision for stale mutation rejection", () => {
    const response = { terminalId: "terminal-1", revision: 8 };
    expect(closePlainTerminalResponseSchema.parse(response)).toEqual(response);
    expect(
      closePlainTerminalResponseSchema.safeParse({
        terminalId: "terminal-1",
      }).success,
    ).toBe(false);
  });
});

describe("plain-terminal family capability", () => {
  it("recognizes only complete v1-local or v2-fleet families", () => {
    expect(familyCapability({}, false)).toEqual({ status: "unknown" });
    expect(familyCapability({}, true)).toEqual({ status: "unsupported" });
    expect(
      familyCapability({ "terminal.plain.list": { major: 2, minor: 0 } }, true),
    ).toEqual({ status: "unsupported" });
    expect(
      familyCapability(
        {
          ...V2_FAMILY,
          "terminal.plain.rename": { major: 1, minor: 0 },
        },
        true,
      ),
    ).toEqual({ status: "unsupported" });
    expect(familyCapability(V1_FAMILY, true)).toEqual({
      status: "capable",
      schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
      topology: "local",
    });
    expect(familyCapability(V2_FAMILY, true)).toEqual({
      status: "capable",
      schemaVersion: PLAIN_TERMINAL_FAMILY_VERSION,
      topology: "fleet",
    });
  });
});

describe("protocol registration and released compatibility", () => {
  it("registers the frozen v1 and fleet v2 unary lines", () => {
    const expected = {
      "terminal.plain.create": [terminalPlainCreateV10, terminalPlainCreateV21],
      "terminal.plain.list": [terminalPlainListV10, terminalPlainListV21],
      "terminal.plain.rename": [terminalPlainRenameV10, terminalPlainRenameV21],
      "terminal.plain.ensureRunning": [
        terminalPlainEnsureRunningV10,
        terminalPlainEnsureRunningV21,
      ],
      "terminal.plain.close": [terminalPlainCloseV10, terminalPlainCloseV21],
      "terminal.plain.importLegacy": [
        terminalPlainImportLegacyV10,
        terminalPlainImportLegacyV21,
      ],
    } as const;

    for (const [method, contracts] of Object.entries(expected)) {
      const entry = hostRpcRegistry[method as keyof typeof expected];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].contract).toBe(contracts[0]);
      expect(entry[2].latestMinor).toBe(1);
      expect(entry[2].versions[1].contract).toBe(contracts[1]);
      expect(0 in entry[2].versions).toBe(false);
    }
  });

  it("registers the v1 incremental and v2 replacement-state streams", () => {
    const entry = hostStreamRpcRegistry["terminal.plain.subscribeList"];
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(terminalPlainSubscribeListV10);
    expect(entry[2].latestMinor).toBe(1);
    expect(entry[2].versions[1].contract).toBe(terminalPlainSubscribeListV21);
    expect(0 in entry[2].versions).toBe(false);
  });

  it("keeps unknown runtime outside the frozen v1 stream", () => {
    expect(
      terminalPlainSubscribeListServerFrameSchemaV10.safeParse({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: unknown,
      }).success,
    ).toBe(false);
  });

  it("keeps the frozen v1 client frame schema independent from v2", () => {
    const ping = { kind: "ping", hasBinaryPayload: false } as const;
    expect(terminalPlainSubscribeListClientFrameSchemaV10.parse(ping)).toEqual(
      ping,
    );
    expect(terminalPlainSubscribeListClientFrameSchemaV10).not.toBe(
      terminalPlainSubscribeListClientFrameSchema,
    );
  });

  it("upgrades an empty v1 Epic list with its request scope and serving host", () => {
    const upgraded = upgradeResponseToVersionWithContext(
      hostRpcRegistry["terminal.plain.list"],
      PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
      PLAIN_TERMINAL_FAMILY_VERSION,
      { terminals: [] },
      {
        request: { scope: epicScope },
        hostId: "host-1",
      },
    );

    expect(upgraded).toEqual({
      coverage: "partial-serving-host",
      scope: epicScope,
      servingHostId: "host-1",
      terminals: [],
    });
  });

  it("upgrades an empty v1 independent list as complete local authority", () => {
    const upgraded = upgradeResponseToVersionWithContext(
      hostRpcRegistry["terminal.plain.list"],
      PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
      PLAIN_TERMINAL_FAMILY_VERSION,
      { terminals: [] },
      {
        request: { scope: independentScope },
        hostId: "host-1",
      },
    );

    expect(upgraded).toEqual({
      coverage: "complete-local",
      scope: independentScope,
      terminals: [],
    });
  });

  it("refuses to down-project a fleet list onto the frozen v1 line", () => {
    expect(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["terminal.plain.list"],
        PLAIN_TERMINAL_FAMILY_VERSION.major,
        PLAIN_TERMINAL_LOCAL_FAMILY_VERSION.major,
        completeFleet,
      ).ok,
    ).toBe(false);
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
    expect(hostRpcRegistry["terminal.list"][2].versions[3].contract).toBe(
      terminalListV23,
    );
    expect(hostRpcRegistry["terminal.rename"][1].versions[0].contract).toBe(
      terminalRenameV10,
    );
  });
});
