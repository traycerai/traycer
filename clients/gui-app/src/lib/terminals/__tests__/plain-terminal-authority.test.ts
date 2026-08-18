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
  markPlainTerminalStreamIncompatible,
  plainTerminalAuthorityCanMutate,
  replacePlainTerminalSnapshot,
  resolvePlainTerminalCapability,
  seedPlainTerminalList,
  selectPlainTerminalViewModel,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  upsertPlainTerminal,
  type LegacyPlainTerminalMigrationAdapter,
  type PlainTerminalCapability,
  type PlainTerminalMigrationAuthority,
} from "@/lib/terminals/plain-terminal-authority";

const HOST_ID = "host-1";
const SCOPE: PlainTerminalScope = { kind: "epic", epicId: "epic-1" };

function terminal(overrides: {
  readonly terminalId?: string;
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
      hostId: HOST_ID,
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

describe("plain terminal capability negotiation", () => {
  it("distinguishes unknown, partial/old, and complete v1 families", () => {
    expect(capability({}, false)).toEqual({ status: "unknown" });
    expect(
      capability({ "terminal.plain.list": { major: 1, minor: 0 } }, true),
    ).toEqual({ status: "legacy" });
    expect(
      capability(
        {
          ...V1_FAMILY,
          "terminal.plain.rename": { major: 2, minor: 0 },
        },
        true,
      ),
    ).toEqual({ status: "legacy" });
    expect(capability(V1_FAMILY, true)).toEqual({
      status: "capable",
      schemaVersion: { major: 1, minor: 0 },
    });
  });

  it("keeps old hosts on local authority and makes a stale capable host view-only", () => {
    const oldHost = capability({}, true);
    const stale = seedPlainTerminalList(
      undefined,
      [terminal({})],
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(plainTerminalAuthorityCanMutate(oldHost, stale)).toBe(false);
    expect(stale.terminalsById["terminal-1"]).toBeDefined();

    const capable = capability(V1_FAMILY, true);
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
      [terminal({})],
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(seeded.terminalsById["terminal-1"]?.record.revision).toBe(1);
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
    expect(
      buffered.terminalsById["terminal-1"]?.runtime.status === "running"
        ? buffered.terminalsById["terminal-1"].runtime.activeProcessName
        : null,
    ).toBe("vitest");

    const converged = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(buffered, [
          terminal({ revision: 3, activeProcessName: "zsh" }),
        ]),
      ),
      "open",
    );
    expect(converged.streamSnapshotFresh).toBe(true);
    expect(converged.terminalsById["terminal-1"]?.record.revision).toBe(3);
  });

  it("preserves an existing fresh snapshot across an accepted list refetch", () => {
    const capable = capability(V1_FAMILY, true);
    const fresh = setPlainTerminalStreamStatus(
      settlePlainTerminalSnapshot(
        replacePlainTerminalSnapshot(undefined, [terminal({})]),
      ),
      "open",
    );
    const barrier = capturePlainTerminalProjectionBarrier(fresh);
    const refetched = seedPlainTerminalList(
      fresh,
      [terminal({ revision: 2 })],
      barrier,
    );
    expect(refetched.streamSnapshotFresh).toBe(true);
    expect(plainTerminalAuthorityCanMutate(capable, refetched)).toBe(true);
  });

  it("keeps an initial list unfresh until the stream supplies a snapshot", () => {
    const listed = seedPlainTerminalList(
      undefined,
      [terminal({})],
      capturePlainTerminalProjectionBarrier(undefined),
    );
    expect(listed.streamSnapshotFresh).toBe(false);
  });

  it("does not restore freshness when an incompatible collection is listed", () => {
    const fresh = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const incompatible = markPlainTerminalStreamIncompatible(fresh);
    const listed = seedPlainTerminalList(
      incompatible,
      [terminal({})],
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
    expect(delayedOlder.terminalsById["terminal-1"]?.record.manualTitle).toBe(
      "newer",
    );

    const deleted = deletePlainTerminal(delayedOlder, "terminal-1", 5);
    expect(deleted.terminalsById["terminal-1"]).toBeUndefined();
    const staleUpsert = upsertPlainTerminal(
      deleted,
      terminal({ revision: 5, manualTitle: "resurrected" }),
    );
    expect(staleUpsert.terminalsById["terminal-1"]).toBeUndefined();
    expect(
      upsertPlainTerminal(
        staleUpsert,
        terminal({ revision: 6, manualTitle: "new logical revision" }),
      ).terminalsById["terminal-1"],
    ).toBeDefined();
  });

  it("treats equal-revision stream and unary deletion evidence as idempotent", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const barrier = capturePlainTerminalProjectionBarrier(initial);
    const deleted = deletePlainTerminal(initial, "terminal-1", 4);
    const sequence = deleted.projectionSequence;

    expect(deletePlainTerminal(deleted, "terminal-1", 4)).toBe(deleted);
    expect(
      adoptPlainTerminalDeletionUnary(deleted, "terminal-1", 4, barrier),
    ).toBe(deleted);
    expect(deleted.projectionSequence).toBe(sequence);
  });

  it("removes rows absent from a reconnect snapshot", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [
      terminal({}),
      terminal({ terminalId: "terminal-2" }),
    ]);
    const next = replacePlainTerminalSnapshot(initial, [terminal({})]);
    expect(Object.keys(next.terminalsById)).toEqual(["terminal-1"]);
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
    expect(
      delayed.terminalsById["terminal-1"]?.runtime.status === "running"
        ? delayed.terminalsById["terminal-1"].runtime.activeProcessName
        : null,
    ).toBe("vitest");
  });

  it("lets reconnect snapshots and deletes dominate requests that began earlier", () => {
    const initial = replacePlainTerminalSnapshot(undefined, [terminal({})]);
    const barrier = capturePlainTerminalProjectionBarrier(initial);
    const reconnecting = setPlainTerminalStreamStatus(initial, "reconnecting");
    const absent = replacePlainTerminalSnapshot(reconnecting, []);
    expect(
      adoptPlainTerminalUnary(absent, terminal({ revision: 2 }), barrier)
        .terminalsById["terminal-1"],
    ).toBeUndefined();

    const restored = replacePlainTerminalSnapshot(absent, [
      terminal({ revision: 3 }),
    ]);
    const deleteBarrier = capturePlainTerminalProjectionBarrier(restored);
    const deleted = deletePlainTerminal(restored, "terminal-1", 4);
    expect(
      adoptPlainTerminalUnary(deleted, terminal({ revision: 4 }), deleteBarrier)
        .terminalsById["terminal-1"],
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
    expect(higher.terminalsById["terminal-1"]?.record.manualTitle).toBe(
      "newer",
    );
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
      capability: overrides.capability ?? capability(V1_FAMILY, true),
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
