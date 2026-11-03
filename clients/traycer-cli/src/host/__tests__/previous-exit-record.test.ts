import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  type RmOptions,
} from "node:fs";
import { dirname } from "node:path";
import { parseHostPreviousExit } from "@traycer/protocol/config/host-previous-exit";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";
import {
  NO_REPORT_MEMORY,
  STDERR_FATAL_KINDS,
  type CrashReportMatch,
  type StderrFatalKind,
} from "../crash-diagnostics";

// Point `store/paths` at a directory of this file's own so the record is never
// written under a real home.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-previous-exit-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// The one seam for a failed replacement: the rename that would publish the
// record can be made to fail, after the temporary file really was written.
const renameFault = vi.hoisted(() => ({
  error: null as Error | null,
  /** A path whose removal fails (the cleanup that follows a failed rename). */
  unremovablePath: null as string | null,
  /** Removals attempted on `unremovablePath`. */
  removalAttempts: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (renameFault.error !== null) throw renameFault.error;
      actual.renameSync(from, to);
    },
    rmSync: (target: string, options: RmOptions | undefined): void => {
      if (renameFault.unremovablePath === target) {
        renameFault.removalAttempts += 1;
        throw Object.assign(new Error("simulated removal failure"), {
          code: "EPERM",
        });
      }
      actual.rmSync(target, options);
    },
  };
});
afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const {
  buildPreviousExit,
  crashKind,
  endedOutOfMemory,
  previousExitRecordPath,
  writePreviousExitRecord,
} = await import("../previous-exit-record");

const ENV: Environment = "production";

function report(overrides: Partial<CrashReportMatch>): CrashReportMatch {
  return {
    filename: "report.json",
    summary: null,
    memory: NO_REPORT_MEMORY,
    heapOutOfMemory: false,
    ...overrides,
  };
}

describe("endedOutOfMemory / crashKind", () => {
  it("is out-of-memory when the fatal line says so, with or without a report", () => {
    expect(endedOutOfMemory("v8-heap-oom", null)).toBe(true);
    expect(endedOutOfMemory("v8-heap-oom", report({}))).toBe(true);
    expect(crashKind("v8-heap-oom", null)).toBe("out-of-memory");
  });

  it("is out-of-memory when only the report says so", () => {
    const oom = report({ heapOutOfMemory: true });
    for (const kind of STDERR_FATAL_KINDS) {
      expect(endedOutOfMemory(kind, oom)).toBe(true);
      expect(crashKind(kind, oom)).toBe("out-of-memory");
    }
  });

  it("is crashed for every other fatal kind without a report flag", () => {
    const others: readonly StderrFatalKind[] = STDERR_FATAL_KINDS.filter(
      (kind) => kind !== "v8-heap-oom",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const kind of others) {
      expect(endedOutOfMemory(kind, null)).toBe(false);
      expect(crashKind(kind, report({}))).toBe("crashed");
    }
  });
});

describe("buildPreviousExit", () => {
  it("maps the fields and takes the heap numbers from the report", () => {
    const record = buildPreviousExit({
      attemptId: "attempt-1",
      endedAtMs: Date.UTC(2026, 10, 2, 10, 0, 0),
      kind: "out-of-memory",
      exitCode: null,
      signal: "SIGABRT",
      report: report({
        memory: {
          ...NO_REPORT_MEMORY,
          heapLimitBytes: 4831838208,
          heapUsedBytes: 4100000000,
        },
      }),
    });
    expect(record).toEqual({
      v: 1,
      attemptId: "attempt-1",
      endedAt: "2026-11-02T10:00:00.000Z",
      kind: "out-of-memory",
      exitCode: null,
      signal: "SIGABRT",
      heapLimitBytes: 4831838208,
      heapUsedBytes: 4100000000,
    });
  });

  it("has null heap numbers when there is no report", () => {
    const record = buildPreviousExit({
      attemptId: "a",
      endedAtMs: 0,
      kind: "exited",
      exitCode: 0,
      signal: null,
      report: null,
    });
    expect(record.heapLimitBytes).toBeNull();
    expect(record.heapUsedBytes).toBeNull();
    expect(record.exitCode).toBe(0);
  });
});

describe("writePreviousExitRecord", () => {
  const record = buildPreviousExit({
    attemptId: "attempt-9",
    endedAtMs: 1_700_000_000_000,
    kind: "crashed",
    exitCode: 3,
    signal: null,
    report: null,
  });

  it("lands in the host home and round-trips through the protocol parser", () => {
    writePreviousExitRecord(ENV, record);
    const onDisk: unknown = JSON.parse(
      readFileSync(previousExitRecordPath(ENV), "utf8"),
    );
    expect(parseHostPreviousExit(onDisk)).toEqual(record);
    expect(onDisk).toEqual(record);
  });

  it("replaces the record whole and leaves no temporary file", () => {
    writePreviousExitRecord(ENV, record);
    const next = {
      ...record,
      attemptId: "attempt-10",
      kind: "exited",
    } as const;
    writePreviousExitRecord(ENV, next);
    const path = previousExitRecordPath(ENV);
    expect(
      parseHostPreviousExit(JSON.parse(readFileSync(path, "utf8"))),
    ).toEqual(next);
    expect(
      readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("removes the old record and the temporary file, and rethrows the original error, when the replacement fails", () => {
    writePreviousExitRecord(ENV, record);
    const path = previousExitRecordPath(ENV);
    expect(existsSync(path)).toBe(true);

    const failure = Object.assign(new Error("simulated rename failure"), {
      code: "EXDEV",
    });
    renameFault.error = failure;
    let thrown: unknown = null;
    try {
      writePreviousExitRecord(ENV, { ...record, attemptId: "attempt-11" });
    } catch (error) {
      thrown = error;
    } finally {
      renameFault.error = null;
    }

    expect(thrown).toBe(failure);
    // The stale record would read as how the NEXT host's predecessor ended.
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("throws the original error and keeps the old record when removing it also fails: a stale record can survive a double failure", () => {
    writePreviousExitRecord(ENV, record);
    const path = previousExitRecordPath(ENV);
    const before = readFileSync(path, "utf8");

    const failure = Object.assign(new Error("simulated rename failure"), {
      code: "EXDEV",
    });
    renameFault.error = failure;
    renameFault.unremovablePath = path;
    renameFault.removalAttempts = 0;
    let thrown: unknown = null;
    try {
      writePreviousExitRecord(ENV, { ...record, attemptId: "attempt-13" });
    } catch (error) {
      thrown = error;
    } finally {
      renameFault.error = null;
      renameFault.unremovablePath = null;
    }

    // The old record's removal WAS attempted, and failed.
    expect(renameFault.removalAttempts).toBe(1);
    // The write's error, not the cleanup's EPERM.
    expect(thrown).toBe(failure);
    // Nothing promises the stale record is gone: here it is still on disk,
    // byte for byte, because it could not be removed.
    expect(readFileSync(path, "utf8")).toBe(before);
    // The temporary file, which could be removed, is gone.
    expect(
      readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("writes a fresh record again after a failed replacement", () => {
    writePreviousExitRecord(ENV, record);
    renameFault.error = new Error("simulated rename failure");
    try {
      expect(() => {
        writePreviousExitRecord(ENV, record);
      }).toThrow("simulated rename failure");
    } finally {
      renameFault.error = null;
    }
    writePreviousExitRecord(ENV, { ...record, attemptId: "attempt-12" });
    expect(
      parseHostPreviousExit(
        JSON.parse(readFileSync(previousExitRecordPath(ENV), "utf8")),
      )?.attemptId,
    ).toBe("attempt-12");
  });

  it("stays under the redirected home", () => {
    expect(previousExitRecordPath(ENV).startsWith(osHome.current)).toBe(true);
  });
});
