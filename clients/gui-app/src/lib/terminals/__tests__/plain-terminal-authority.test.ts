import { describe, expect, it, vi, type Mock } from "vitest";
import type {
  ImportLegacyPlainTerminalResponse,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  PLAIN_TERMINAL_RPC_METHODS,
  PlainTerminalMigrationCoordinator,
  adoptPlainTerminalDeletionUnary,
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  deletePlainTerminal,
  emptyPlainTerminalCollection,
  getPlainTerminal,
  plainTerminalHostScopeIdentityKey,
  plainTerminalMigrationIdentityKey,
  markPlainTerminalStreamIncompatible,
  plainTerminalActionAuthorized,
  plainTerminalAuthorityCanMutate,
  replacePlainTerminalSnapshot,
  replacePlainTerminalState,
  resolvePlainTerminalCapability,
  seedPlainTerminalList,
  selectPlainTerminalViewModel,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  upsertPlainTerminal,
  type LegacyPlainTerminalMigrationAdapter,
  type PlainTerminalCollection,
  type PlainTerminalCapability,
  type PlainTerminalMigrationAuthority,
} from "@/lib/terminals/plain-terminal-authority";

const HOST_ID = "host-1";
const SCOPE = {
  kind: "epic",
  epicId: "epic-1",
} as const satisfies PlainTerminalScope;

function lookup(
  collection: PlainTerminalCollection,
  terminalId: string,
): PlainTerminalProjection | undefined {
  return getPlainTerminal(collection, HOST_ID, terminalId);
}

function lookupForHost(
  collection: PlainTerminalCollection,
  terminalId: string,
  hostId: string,
): PlainTerminalProjection | undefined {
  return getPlainTerminal(collection, hostId, terminalId);
}

function runningProcessName(
  projection: PlainTerminalProjection | undefined,
): string | null {
  return projection?.runtime.status === "running"
    ? projection.runtime.activeProcessName
    : null;
}

function fleetState(terminals: readonly PlainTerminalProjection[]) {
  return {
    coverage: "complete-fleet" as const,
    scope: SCOPE,
    terminals: [...terminals],
  };
}

function fleetStateWithCoverage(
  terminals: readonly PlainTerminalProjection[],
  coverage: "partial-serving-host" | "complete-local",
) {
  if (coverage === "complete-local") {
    return {
      coverage,
      scope: { kind: "independent" as const },
      terminals: [...terminals],
    };
  }
  return {
    coverage,
    scope: SCOPE,
    servingHostId: HOST_ID,
    terminals: [...terminals],
  };
}

function terminal(overrides: {
  readonly terminalId?: string;
  readonly hostId?: string;
  readonly revision?: number;
  readonly manualTitle?: string | null;
  readonly status?: "running" | "dormant";
  readonly currentCwd?: string;
  readonly activeProcessName?: string | null;
}): PlainTerminalProjection {
  const terminalId = overrides.terminalId ?? "terminal-1";
  const runtime =
    overrides.status === "dormant"
      ? ({ status: "dormant" } as const)
      : ({
          status: "running",
          sessionId: terminalId,
          currentCwd: overrides.currentCwd ?? "/work/live",
          activeProcessName:
            overrides.activeProcessName === undefined
              ? "bun"
              : overrides.activeProcessName,
          cols: 100,
          rows: 30,
        } as const);
  return {
    record: {
      terminalId,
      hostId: overrides.hostId ?? HOST_ID,
      scope: SCOPE,
      launch: {
        cwd: "/work/launch",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: overrides.manualTitle ?? null,
      revision: overrides.revision ?? 1,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime,
  };
}

function capability(
  versions: Readonly<Record<string, { major: number; minor: number }>>,
  manifestKnown: boolean,
): PlainTerminalCapability {
  return resolvePlainTerminalCapability({
    manifestKnown,
    versionFor: (method) => versions[method] ?? null,
  });
}

const V1_FAMILY = Object.fromEntries(
  PLAIN_TERMINAL_RPC_METHODS.map((method) => [method, { major: 1, minor: 0 }]),
);
const V2_FAMILY = Object.fromEntries(
  PLAIN_TERMINAL_RPC_METHODS.map((method) => [method, { major: 2, minor: 1 }]),
);
const V2_DRAFT_FAMILY = Object.fromEntries(
  PLAIN_TERMINAL_RPC_METHODS.map((method) => [method, { major: 2, minor: 0 }]),
);

describe("plain terminal capability negotiation", () => {
  it("recognizes frozen local v1 and fleet v2 only as complete families", () => {
    expect(capability({}, false)).toEqual({ status: "unknown" });
    expect(
      capability({ "terminal.plain.list": { major: 2, minor: 0 } }, true),
    ).toEqual({ status: "legacy" });
    expect(capability(V1_FAMILY, true)).toEqual({
      status: "capable",
      schemaVersion: { major: 1, minor: 0 },
    });
    expect(capability(V2_DRAFT_FAMILY, true)).toEqual({ status: "legacy" });
    expect(
      capability(
        {
          ...V2_FAMILY,
          "terminal.plain.rename": { major: 1, minor: 0 },
        },
        true,
      ),
    ).toEqual({ status: "legacy" });
    expect(capability(V2_FAMILY, true)).toEqual({
      status: "capable",
      schemaVersion: { major: 2, minor: 1 },
    });
  });

  it("keeps hosts without a durable family on legacy authority and makes a stale capable host view-only", () => {
    const oldHost = capability({}, true);
    const stale = seedPlainTerminalList(
      undefined,
      fleetState([terminal({})]),
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(plainTerminalAuthorityCanMutate(oldHost, stale)).toBe(false);
    expect(lookup(stale, "terminal-1")).toBeDefined();

    const capable = capability(V2_FAMILY, true);
    expect(plainTerminalAuthorityCanMutate(capable, stale)).toBe(false);
    const fresh = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(stale, [terminal({})]),
      ),
      "open",
    );
    expect(plainTerminalAuthorityCanMutate(capable, fresh)).toBe(true);
  });
});

describe("plain terminal collection convergence", () => {
  it("seeds from list, buffers reconnect updates, then converges to the next snapshot", () => {
    const seeded = seedPlainTerminalList(
      undefined,
      fleetState([terminal({})]),
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(lookup(seeded, "terminal-1")?.record.revision).toBe(1);
    expect(seeded.streamSnapshotFresh).toBe(false);

    const initial = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(seeded, [terminal({})]),
      ),
      "open",
    );
    expect(initial.streamSnapshotFresh).toBe(true);

    const reconnecting = setPlainTerminalStreamStatus(initial, "reconnecting");
    const buffered = upsertPlainTerminal(
      reconnecting,
      terminal({ revision: 2, activeProcessName: "vitest" }),
    );
    expect(buffered.streamSnapshotFresh).toBe(false);
    expect(runningProcessName(lookup(buffered, "terminal-1"))).toBe("vitest");

    const converged = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(buffered, [
          terminal({ revision: 3, activeProcessName: "zsh" }),
        ]),
      ),
      "open",
    );
    expect(converged.streamSnapshotFresh).toBe(true);
    expect(lookup(converged, "terminal-1")?.record.revision).toBe(3);
  });

  it("preserves an existing fresh snapshot across an accepted list refetch", () => {
    const capable = capability(V2_FAMILY, true);
    const fresh = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(undefined, [terminal({})]),
      ),
      "open",
    );
    const barrier = capturePlainTerminalProjectionBarrier(fresh);
    const refetched = seedPlainTerminalList(
      fresh,
      fleetState([terminal({ revision: 2 })]),
      barrier,
    );
    expect(refetched.streamSnapshotFresh).toBe(true);
    expect(plainTerminalAuthorityCanMutate(capable, refetched)).toBe(true);
  });

  it("keeps an initial list unfresh until the stream supplies a snapshot", () => {
    const listed = seedPlainTerminalList(
      undefined,
      fleetState([terminal({})]),
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(listed.streamSnapshotFresh).toBe(false);
  });

  it("does not restore freshness when an incompatible collection is listed", () => {
    const fresh = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const incompatible = markPlainTerminalStreamIncompatible(fresh);
    const listed = seedPlainTerminalList(
      incompatible,
      fleetState([terminal({})]),
      capturePlainTerminalProjectionBarrier(incompatible),
    );
    expect(listed.streamCompatibility).toBe("incompatible");
    expect(listed.streamSnapshotFresh).toBe(false);
  });

  it("orders concurrent canonical writes by revision and blocks resurrection after deletion", () => {
    const newer = upsertPlainTerminal(
      emptyPlainTerminalCollection(),
      terminal({ revision: 4, manualTitle: "newer" }),
    );
    const delayedOlder = upsertPlainTerminal(
      newer,
      terminal({ revision: 3, manualTitle: "older" }),
    );
    expect(lookup(delayedOlder, "terminal-1")?.record.manualTitle).toBe(
      "newer",
    );

    const deleted = deletePlainTerminal(
      delayedOlder,
      { hostId: HOST_ID, terminalId: "terminal-1" },
      5,
    );
    expect(lookup(deleted, "terminal-1")).toBeUndefined();
    const staleUpsert = upsertPlainTerminal(
      deleted,
      terminal({ revision: 5, manualTitle: "resurrected" }),
    );
    expect(lookup(staleUpsert, "terminal-1")).toBeUndefined();
    expect(
      lookup(
        upsertPlainTerminal(
          staleUpsert,
          terminal({ revision: 6, manualTitle: "new logical revision" }),
        ),
        "terminal-1",
      ),
    ).toBeDefined();
  });

  it("treats equal-revision stream and unary deletion evidence as idempotent", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const barrier = capturePlainTerminalProjectionBarrier(initial);
    const identity = { hostId: HOST_ID, terminalId: "terminal-1" };
    const deleted = deletePlainTerminal(initial, identity, 4);
    const sequence = deleted.projectionSequence;

    expect(deletePlainTerminal(deleted, identity, 4)).toBe(deleted);
    expect(adoptPlainTerminalDeletionUnary(deleted, identity, 4, barrier)).toBe(
      deleted,
    );
    expect(deleted.projectionSequence).toBe(sequence);
  });

  it("removes rows absent from a reconnect snapshot", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [
      terminal({}),
      terminal({ terminalId: "terminal-2" }),
    ]);
    const next = replacePlainTerminalSnapshot(initial, [terminal({})]);
    expect(lookup(next, "terminal-1")).toBeDefined();
    expect(lookup(next, "terminal-2")).toBeUndefined();
  });

  it("keeps equal-revision stream runtime newer than a delayed unary result", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const barrier = capturePlainTerminalProjectionBarrier(initial);
    const live = upsertPlainTerminal(
      initial,
      terminal({ revision: 1, activeProcessName: "vitest" }),
    );
    const delayed = adoptPlainTerminalUnary(
      live,
      terminal({ revision: 1, activeProcessName: "zsh" }),
      barrier,
    );
    expect(runningProcessName(lookup(delayed, "terminal-1"))).toBe("vitest");
  });

  it("lets reconnect snapshots and deletes dominate requests that began earlier", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const barrier = capturePlainTerminalProjectionBarrier(initial);
    const reconnecting = setPlainTerminalStreamStatus(initial, "reconnecting");
    const absent = replacePlainTerminalSnapshot(reconnecting, []);
    expect(
      lookup(
        adoptPlainTerminalUnary(absent, terminal({ revision: 2 }), barrier),
        "terminal-1",
      ),
    ).toBeUndefined();

    const restored = replacePlainTerminalSnapshot(absent, [
      terminal({ revision: 3 }),
    ]);
    const deleteBarrier = capturePlainTerminalProjectionBarrier(restored);
    const deleted = deletePlainTerminal(
      restored,
      { hostId: HOST_ID, terminalId: "terminal-1" },
      4,
    );
    expect(
      lookup(
        adoptPlainTerminalUnary(
          deleted,
          terminal({ revision: 4 }),
          deleteBarrier,
        ),
        "terminal-1",
      ),
    ).toBeUndefined();
  });

  it("adopts legitimate post-snapshot and higher-revision unary projections", () => {
    const snapshot = replacePlainTerminalSnapshot(undefined, []);
    const postSnapshotBarrier = capturePlainTerminalProjectionBarrier(snapshot);
    const created = adoptPlainTerminalUnary(
      snapshot,
      terminal({ revision: 2 }),
      postSnapshotBarrier,
    );
    const higher = adoptPlainTerminalUnary(
      created,
      terminal({ revision: 3, manualTitle: "newer" }),
      postSnapshotBarrier,
    );
    expect(lookup(higher, "terminal-1")?.record.manualTitle).toBe("newer");
  });

  it("keeps the same terminalId on two hosts as distinct fleet identities", () => {
    const next = replacePlainTerminalState(
      undefined,
      fleetState([
        terminal({ terminalId: "shared", hostId: "host-a" }),
        terminal({ terminalId: "shared", hostId: "host-b" }),
      ]),
    );
    expect(lookupForHost(next, "shared", "host-a")).toBeDefined();
    expect(lookupForHost(next, "shared", "host-b")).toBeDefined();
    expect(Object.keys(next.terminalsByIdentity)).toHaveLength(2);
  });

  it("replaces the whole collection and drops omitted rows", () => {
    const initial = replacePlainTerminalState(
      undefined,
      fleetState([
        terminal({ terminalId: "keep" }),
        terminal({ terminalId: "drop" }),
      ]),
    );
    const replaced = replacePlainTerminalState(
      initial,
      fleetState([terminal({ terminalId: "keep", revision: 2 })]),
    );
    expect(lookup(replaced, "keep")?.record.revision).toBe(2);
    expect(lookup(replaced, "drop")).toBeUndefined();
    expect(replaced.coverage).toBe("complete-fleet");
  });

  it("drops remote rows on partial coverage and restores only the later complete state", () => {
    const complete = replacePlainTerminalState(
      undefined,
      fleetState([
        terminal({ terminalId: "local" }),
        terminal({ terminalId: "remote", hostId: "host-b" }),
      ]),
    );
    expect(plainTerminalActionAuthorized(complete, "host-b", "remote")).toBe(
      true,
    );
    const partial = replacePlainTerminalState(
      complete,
      fleetStateWithCoverage(
        [terminal({ terminalId: "local", revision: 2 })],
        "partial-serving-host",
      ),
    );
    expect(partial.coverage).toBe("partial-serving-host");
    expect(partial.servingHostId).toBe(HOST_ID);
    expect(lookup(partial, "local")?.record.revision).toBe(2);
    expect(lookupForHost(partial, "remote", "host-b")).toBeUndefined();
    expect(plainTerminalActionAuthorized(partial, "host-b", "remote")).toBe(
      false,
    );
    const restored = replacePlainTerminalState(
      partial,
      fleetState([terminal({ terminalId: "other-remote", hostId: "host-b" })]),
    );
    expect(restored.coverage).toBe("complete-fleet");
    expect(lookupForHost(restored, "remote", "host-b")).toBeUndefined();
    expect(lookupForHost(restored, "other-remote", "host-b")).toBeDefined();
    expect(lookup(restored, "local")).toBeUndefined();
  });

  it("keeps independent complete-local replacement isolated from fleet coverage", () => {
    const local = replacePlainTerminalState(
      undefined,
      fleetStateWithCoverage(
        [
          terminal({
            terminalId: "home",
            hostId: HOST_ID,
          }),
        ],
        "complete-local",
      ),
    );
    expect(local.coverage).toBe("complete-local");
    expect(local.servingHostId).toBeNull();
    const ignoredFleet = seedPlainTerminalList(
      local,
      fleetState([terminal({ terminalId: "fleet" })]),
      capturePlainTerminalProjectionBarrier(local),
    );
    expect(ignoredFleet).toBe(local);
  });
});

describe("plain terminal title selector", () => {
  it.each([
    {
      name: "manual-only title",
      projection: terminal({
        manualTitle: "Deploy shell",
        activeProcessName: null,
      }),
      expected: {
        manualTitle: "Deploy shell",
        activeProcessName: null,
        liveCwd: "/work/live",
        runtimeStatus: "running",
        displayTitle: "Deploy shell",
      },
    },
    {
      name: "live process and cwd",
      projection: terminal({
        manualTitle: null,
        currentCwd: "/repo/api",
        activeProcessName: "vitest",
      }),
      expected: {
        manualTitle: null,
        activeProcessName: "vitest",
        liveCwd: "/repo/api",
        runtimeStatus: "running",
        displayTitle: "api · vitest",
      },
    },
    {
      name: "combined manual title and process",
      projection: terminal({
        manualTitle: "Deploy shell",
        activeProcessName: "bun",
      }),
      expected: {
        manualTitle: "Deploy shell",
        activeProcessName: "bun",
        liveCwd: "/work/live",
        runtimeStatus: "running",
        displayTitle: "Deploy shell",
      },
    },
    {
      name: "dormant launch cwd",
      projection: terminal({ status: "dormant" }),
      expected: {
        manualTitle: null,
        activeProcessName: null,
        liveCwd: null,
        runtimeStatus: "dormant",
        displayTitle: "launch · New Terminal",
      },
    },
  ])("keeps semantic state distinct for $name", ({ projection, expected }) => {
    expect(selectPlainTerminalViewModel(projection)).toMatchObject(expected);
  });
});

describe("legacy terminal migration coordination", () => {
  function adapter(): LegacyPlainTerminalMigrationAdapter & {
    readonly adoptCanonical: Mock<
      LegacyPlainTerminalMigrationAdapter["adoptCanonical"]
    >;
  } {
    return {
      read: () => ({
        terminalId: "terminal-1",
        hostId: HOST_ID,
        scope: SCOPE,
        cwd: "/legacy/cwd",
        name: "Legacy name",
        titleSource: "manual",
        sourceStoreVersion: 7,
      }),
      adoptCanonical: typedCanonicalAdopter(),
    };
  }

  function typedCanonicalAdopter(): Mock<
    LegacyPlainTerminalMigrationAdapter["adoptCanonical"]
  > {
    return vi.fn<LegacyPlainTerminalMigrationAdapter["adoptCanonical"]>();
  }

  function authority(overrides: {
    readonly capability?: PlainTerminalCapability;
    readonly canMutate?: boolean;
    readonly importLegacy?: PlainTerminalMigrationAuthority["importLegacy"];
  }): PlainTerminalMigrationAuthority {
    return {
      hostId: HOST_ID,
      scope: SCOPE,
      capability: overrides.capability ?? capability(V2_FAMILY, true),
      canMutate: overrides.canMutate ?? true,
      importLegacy:
        overrides.importLegacy ??
        (() => Promise.resolve({ status: "existing", terminal: terminal({}) })),
    };
  }

  it("preserves legacy fields on old/unreachable hosts and import failures", async () => {
    const coordinator = new PlainTerminalMigrationCoordinator();
    const legacy = adapter();
    expect(
      await coordinator.migrate(
        authority({ capability: { status: "legacy" } }),
        legacy,
      ),
    ).toEqual({ status: "preserved", reason: "legacy-host" });
    expect(
      await coordinator.migrate(authority({ canMutate: false }), legacy),
    ).toEqual({ status: "preserved", reason: "stale" });
    await expect(
      coordinator.migrate(
        authority({
          importLegacy: () => Promise.reject(new Error("host unavailable")),
        }),
        legacy,
      ),
    ).rejects.toThrow("host unavailable");
    expect(legacy.adoptCanonical).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "imported" as const,
      winner: {
        status: "imported" as const,
        terminal: terminal({ revision: 9, manualTitle: "Imported winner" }),
      },
      callback: "adoptCanonical" as const,
    },
    {
      status: "existing" as const,
      winner: {
        status: "existing" as const,
        terminal: terminal({ revision: 9, manualTitle: "Existing winner" }),
      },
      callback: "adoptCanonical" as const,
    },
  ])(
    "deduplicates the $status host import but acknowledges every adapter",
    async ({ winner, callback }) => {
      const coordinator = new PlainTerminalMigrationCoordinator();
      const firstAdapter = adapter();
      const secondAdapter = adapter();
      let resolveImport: (
        response: ImportLegacyPlainTerminalResponse,
      ) => void = () => undefined;
      const importLegacy = vi.fn(
        () =>
          new Promise<ImportLegacyPlainTerminalResponse>((resolve) => {
            resolveImport = resolve;
          }),
      );
      const first = coordinator.migrate(
        authority({ importLegacy }),
        firstAdapter,
      );
      const second = coordinator.migrate(
        authority({ importLegacy }),
        secondAdapter,
      );
      expect(importLegacy).toHaveBeenCalledTimes(1);
      resolveImport(winner);
      await expect(first).resolves.toEqual({
        status: "adopted",
        response: winner,
      });
      await expect(second).resolves.toEqual({
        status: "adopted",
        response: winner,
      });
      expect(firstAdapter[callback]).toHaveBeenCalledWith(winner);
      expect(secondAdapter[callback]).toHaveBeenCalledWith(winner);
    },
  );

  it("deduplicates deleted imports without bypassing the mutation-owned deletion boundary", async () => {
    const coordinator = new PlainTerminalMigrationCoordinator();
    const firstAdapter = adapter();
    const secondAdapter = adapter();
    const winner: ImportLegacyPlainTerminalResponse = {
      status: "deleted",
      terminalId: "terminal-1",
      revision: 9,
    };
    const importLegacy = vi.fn(() => Promise.resolve(winner));

    await expect(
      Promise.all([
        coordinator.migrate(authority({ importLegacy }), firstAdapter),
        coordinator.migrate(authority({ importLegacy }), secondAdapter),
      ]),
    ).resolves.toEqual([
      { status: "adopted", response: winner },
      { status: "adopted", response: winner },
    ]);
    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(firstAdapter.adoptCanonical).not.toHaveBeenCalled();
    expect(secondAdapter.adoptCanonical).not.toHaveBeenCalled();
  });

  it("preserves every adapter's evidence when a shared import rejects and permits retry", async () => {
    const coordinator = new PlainTerminalMigrationCoordinator();
    const firstAdapter = adapter();
    const secondAdapter = adapter();
    let rejectImport: (error: Error) => void = () => undefined;
    const importLegacy = vi.fn(
      () =>
        new Promise<ImportLegacyPlainTerminalResponse>((_resolve, reject) => {
          rejectImport = reject;
        }),
    );
    const first = coordinator.migrate(
      authority({ importLegacy }),
      firstAdapter,
    );
    const second = coordinator.migrate(
      authority({ importLegacy }),
      secondAdapter,
    );
    rejectImport(new Error("host unavailable"));
    await expect(first).rejects.toThrow("host unavailable");
    await expect(second).rejects.toThrow("host unavailable");
    expect(firstAdapter.adoptCanonical).not.toHaveBeenCalled();
    expect(secondAdapter.adoptCanonical).not.toHaveBeenCalled();

    await expect(
      coordinator.migrate(
        authority({
          importLegacy: () =>
            Promise.resolve({ status: "existing", terminal: terminal({}) }),
        }),
        firstAdapter,
      ),
    ).resolves.toMatchObject({ status: "adopted" });
  });

  it("isolates adapter acknowledgement failure after a deduplicated host result", async () => {
    const coordinator = new PlainTerminalMigrationCoordinator();
    const firstAdapter = adapter();
    const secondAdapter = adapter();
    firstAdapter.adoptCanonical.mockRejectedValue(
      new Error("first legacy store unavailable"),
    );
    const winner: ImportLegacyPlainTerminalResponse = {
      status: "existing",
      terminal: terminal({ revision: 9 }),
    };
    const importLegacy = vi.fn(() => Promise.resolve(winner));

    const first = coordinator.migrate(
      authority({ importLegacy }),
      firstAdapter,
    );
    const second = coordinator.migrate(
      authority({ importLegacy }),
      secondAdapter,
    );
    await expect(first).rejects.toThrow("first legacy store unavailable");
    await expect(second).resolves.toEqual({
      status: "adopted",
      response: winner,
    });
    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(secondAdapter.adoptCanonical).toHaveBeenCalledWith(winner);
  });
});

describe("plain terminal JSON tuple identity keys", () => {
  it("does not collide host/scope stream keys on NUL, quotes, or backslashes", () => {
    const pairs: readonly (readonly [
      readonly [string, PlainTerminalScope],
      readonly [string, PlainTerminalScope],
    ])[] = [
      [
        ["a", { kind: "epic", epicId: "b\u0000independent" }],
        ["a\u0000epic:b", { kind: "independent" }],
      ],
      [
        ["a", { kind: "epic", epicId: 'b","independent' }],
        ['a","epic:b', { kind: "independent" }],
      ],
      [
        ["a\\", { kind: "epic", epicId: "b" }],
        ["a", { kind: "epic", epicId: "\\b" }],
      ],
    ];
    for (const [left, right] of pairs) {
      expect(plainTerminalHostScopeIdentityKey(left[0], left[1])).not.toBe(
        plainTerminalHostScopeIdentityKey(right[0], right[1]),
      );
    }
  });

  it("does not collide migration keys when NUL splits host, scope, or terminal", () => {
    const pairs: readonly (readonly [
      readonly [string, PlainTerminalScope, string],
      readonly [string, PlainTerminalScope, string],
    ])[] = [
      [
        ["a", { kind: "epic", epicId: "b" }, "c\u0000d"],
        ["a", { kind: "epic", epicId: "b\u0000c" }, "d"],
      ],
      [
        ["a", { kind: "epic", epicId: "b\u0000independent" }, "term"],
        ["a\u0000epic:b", { kind: "independent" }, "term"],
      ],
      [
        ["a", { kind: "epic", epicId: 'b","c' }, "d"],
        ["a", { kind: "epic", epicId: "b" }, 'c","d'],
      ],
      [
        ["a\\", { kind: "epic", epicId: "b" }, "c"],
        ["a", { kind: "epic", epicId: "\\b" }, "c"],
      ],
    ];
    for (const [left, right] of pairs) {
      expect(
        plainTerminalMigrationIdentityKey(left[0], left[1], left[2]),
      ).not.toBe(
        plainTerminalMigrationIdentityKey(right[0], right[1], right[2]),
      );
    }
  });
});
