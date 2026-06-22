import { describe, expect, it } from "vitest";
import {
  migrationRunClientFrameSchema,
  migrationRunServerFrameSchema,
  migrationRunV10,
} from "@traycer/protocol/host/migration/run";

/**
 * `migration.run@1.0` frame fixtures.
 *
 * Covers every frame kind the contract declares. All frames are JSON-only
 * - `hasBinaryPayload` is pinned to the `false` literal everywhere.
 */

describe("migration.run@1.0 server frames", () => {
  it("parses a started frame", () => {
    const parsed = migrationRunServerFrameSchema.parse({
      kind: "started",
      totalTaskChains: 100,
      totalLocalEpics: 12,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("started");
    if (parsed.kind === "started") {
      expect(parsed.totalTaskChains).toBe(100);
      expect(parsed.totalLocalEpics).toBe(12);
    }
  });

  it("parses a taskChainProgress frame for every outcome", () => {
    for (const outcome of ["complete", "skipped", "failed"] as const) {
      const parsed = migrationRunServerFrameSchema.parse({
        kind: "taskChainProgress",
        chainId: "abc",
        index: 0,
        total: 3,
        outcome,
        hasBinaryPayload: false,
      });
      expect(parsed.kind).toBe("taskChainProgress");
      if (parsed.kind === "taskChainProgress") {
        expect(parsed.outcome).toBe(outcome);
      }
    }
  });

  it("parses an epicProgress frame", () => {
    const parsed = migrationRunServerFrameSchema.parse({
      kind: "epicProgress",
      epicId: "xyz",
      index: 1,
      total: 2,
      outcome: "failed",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("epicProgress");
  });

  it("parses a replayProgress frame", () => {
    const parsed = migrationRunServerFrameSchema.parse({
      kind: "replayProgress",
      entityId: "ent",
      entityKind: "chain",
      required: true,
      completed: false,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("replayProgress");
  });

  it("parses a complete frame", () => {
    const parsed = migrationRunServerFrameSchema.parse({
      kind: "complete",
      success: true,
      counts: {
        taskChainsComplete: 5,
        taskChainsSkipped: 1,
        taskChainsFailed: 0,
        epicsComplete: 2,
        epicsFailed: 0,
        replaysIncomplete: 0,
      },
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("complete");
    if (parsed.kind === "complete") {
      expect(parsed.success).toBe(true);
      expect(parsed.counts.taskChainsComplete).toBe(5);
    }
  });

  it("parses a pong frame", () => {
    const parsed = migrationRunServerFrameSchema.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("pong");
  });

  it("rejects a started frame that claims a binary payload", () => {
    expect(() =>
      migrationRunServerFrameSchema.parse({
        kind: "started",
        totalTaskChains: 1,
        totalLocalEpics: 0,
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a complete frame with negative counts", () => {
    expect(() =>
      migrationRunServerFrameSchema.parse({
        kind: "complete",
        success: false,
        counts: {
          taskChainsComplete: -1,
          taskChainsSkipped: 0,
          taskChainsFailed: 0,
          epicsComplete: 0,
          epicsFailed: 0,
          replaysIncomplete: 0,
        },
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });
});

describe("migration.run@1.0 client frames", () => {
  it("parses a ping frame", () => {
    const parsed = migrationRunClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("ping");
  });

  it("rejects an unknown client frame kind", () => {
    expect(() =>
      migrationRunClientFrameSchema.parse({
        kind: "applyUpdate",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("migration.run@1.0 open request", () => {
  it("accepts an empty object", () => {
    const parsed = migrationRunV10.openRequestSchema.parse({});
    expect(parsed).toEqual({});
  });
});
