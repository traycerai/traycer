import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-report-ledger-unused",
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  REPORT_LEDGER_MAX_FINGERPRINTS,
  REPORT_LEDGER_MAX_REPORTS,
  REPORT_LEDGER_TTL_MS,
  __flushReportLedgerForTest,
  __resetReportLedgerForTest,
  getFingerprintOccurrence,
  parseReportLedgerState,
  pruneReportLedgerState,
  recordFiledReport,
  recordFingerprintSighting,
  type FingerprintSighting,
  type ReportLedgerState,
} from "../report-ledger";

let tempDir: string;
let storeFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "traycer-report-ledger-"));
  storeFile = join(tempDir, "report-ledger.json");
  __resetReportLedgerForTest({ storePath: storeFile });
});

afterEach(() => {
  __resetReportLedgerForTest({ storePath: null });
  rmSync(tempDir, { recursive: true, force: true });
});

function emptyState(): ReportLedgerState {
  return { version: 1, fingerprints: {}, reports: [] };
}

describe("parseReportLedgerState", () => {
  it("returns empty for non-objects and wrong version", () => {
    expect(parseReportLedgerState(null)).toEqual(emptyState());
    expect(parseReportLedgerState("x")).toEqual(emptyState());
    expect(parseReportLedgerState([])).toEqual(emptyState());
    expect(parseReportLedgerState({ version: 99 })).toEqual(emptyState());
  });

  it("drops malformed fingerprint and report entries", () => {
    const parsed = parseReportLedgerState({
      version: 1,
      fingerprints: {
        good: { firstSeen: 1, lastSeen: 2, count: 3 },
        badCount: { firstSeen: 1, lastSeen: 2, count: 0 },
        badShape: { firstSeen: "nope" },
      },
      reports: [
        { reportId: "rpt_a", fingerprint: "fp:1", timestamp: 10 },
        { reportId: "", fingerprint: "fp:1", timestamp: 10 },
        { reportId: "rpt_b", fingerprint: "fp:1" },
        "not-an-object",
      ],
    });
    expect(parsed.fingerprints).toEqual({
      good: { firstSeen: 1, lastSeen: 2, count: 3 },
    });
    expect(parsed.reports).toEqual([
      { reportId: "rpt_a", fingerprint: "fp:1", timestamp: 10 },
    ]);
  });
});

describe("pruneReportLedgerState", () => {
  const now = 1_000_000_000_000;
  const ttl = REPORT_LEDGER_TTL_MS;

  it("evicts TTL-expired fingerprints and reports", () => {
    const stale = now - ttl - 1;
    const fresh = now - 1_000;
    const pruned = pruneReportLedgerState(
      {
        version: 1,
        fingerprints: {
          old: { firstSeen: stale, lastSeen: stale, count: 5 },
          young: { firstSeen: fresh, lastSeen: fresh, count: 1 },
        },
        reports: [
          { reportId: "rpt_old", fingerprint: "old", timestamp: stale },
          { reportId: "rpt_new", fingerprint: "young", timestamp: fresh },
        ],
      },
      now,
      {
        maxFingerprints: REPORT_LEDGER_MAX_FINGERPRINTS,
        maxReports: REPORT_LEDGER_MAX_REPORTS,
        ttlMs: ttl,
      },
    );
    expect(Object.keys(pruned.fingerprints)).toEqual(["young"]);
    expect(pruned.reports.map((r) => r.reportId)).toEqual(["rpt_new"]);
  });

  it("LRU-evicts fingerprints down to the cap by lastSeen", () => {
    const fingerprints: Record<string, FingerprintSighting> = {};
    for (let i = 0; i < 10; i += 1) {
      fingerprints[`fp:${i}`] = {
        firstSeen: now - 10_000 + i,
        lastSeen: now - 10_000 + i,
        count: 1,
      };
    }
    const pruned = pruneReportLedgerState(
      { version: 1, fingerprints, reports: [] },
      now,
      { maxFingerprints: 3, maxReports: 500, ttlMs: ttl },
    );
    // Keep the three most recently seen: fp:7, fp:8, fp:9
    expect(Object.keys(pruned.fingerprints).sort()).toEqual([
      "fp:7",
      "fp:8",
      "fp:9",
    ]);
  });

  it("LRU-evicts filed reports down to the cap by timestamp", () => {
    const reports = Array.from({ length: 10 }, (_, i) => ({
      reportId: `rpt_${i}`,
      fingerprint: "fp:x",
      timestamp: now - 10_000 + i,
    }));
    const pruned = pruneReportLedgerState(
      { version: 1, fingerprints: {}, reports },
      now,
      { maxFingerprints: 500, maxReports: 3, ttlMs: ttl },
    );
    expect(pruned.reports.map((r) => r.reportId)).toEqual([
      "rpt_7",
      "rpt_8",
      "rpt_9",
    ]);
  });

  it("a crash-looping fingerprint cannot grow the file unboundedly", () => {
    // One fingerprint is one entry regardless of count - the unbounded risk
    // is many unique fingerprints or many filed reports. Cap both.
    let state = emptyState();
    for (let i = 0; i < REPORT_LEDGER_MAX_FINGERPRINTS + 200; i += 1) {
      state = {
        ...state,
        fingerprints: {
          ...state.fingerprints,
          [`fp:unique:${i}`]: {
            firstSeen: now - REPORT_LEDGER_MAX_FINGERPRINTS + i,
            lastSeen: now - REPORT_LEDGER_MAX_FINGERPRINTS + i,
            count: 1_000_000,
          },
        },
      };
    }
    // Also spam the same fingerprint's count - must stay one row.
    state = {
      ...state,
      fingerprints: {
        ...state.fingerprints,
        "fp:loop": {
          firstSeen: now,
          lastSeen: now,
          count: 9_999_999,
        },
      },
    };
    const pruned = pruneReportLedgerState(state, now, {
      maxFingerprints: REPORT_LEDGER_MAX_FINGERPRINTS,
      maxReports: REPORT_LEDGER_MAX_REPORTS,
      ttlMs: ttl,
    });
    expect(Object.keys(pruned.fingerprints).length).toBe(
      REPORT_LEDGER_MAX_FINGERPRINTS,
    );
    expect(pruned.fingerprints["fp:loop"]?.count).toBe(9_999_999);
  });
});

describe("recordFingerprintSighting / recordFiledReport persistence", () => {
  it("separates sightings from filed reports", async () => {
    await recordFingerprintSighting("fp:v1:abc");
    await recordFingerprintSighting("fp:v1:abc");
    // Sighting alone must not invent a filed report.
    expect(await getFingerprintOccurrence("fp:v1:abc")).toMatchObject({
      count: 2,
    });
    const afterSightings = JSON.parse(readFileSync(storeFile, "utf8")) as {
      reports: unknown[];
    };
    expect(afterSightings.reports).toEqual([]);

    await recordFiledReport(
      "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "fp:v1:abc",
    );
    const afterFiled = JSON.parse(readFileSync(storeFile, "utf8")) as {
      fingerprints: Record<string, { count: number }>;
      reports: Array<{ reportId: string; fingerprint: string }>;
    };
    // Filing does not bump the sighting count - the two concepts stay separate.
    expect(afterFiled.fingerprints["fp:v1:abc"]?.count).toBe(2);
    expect(afterFiled.reports).toEqual([
      {
        reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fingerprint: "fp:v1:abc",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("survives a store reload (app restart)", async () => {
    await recordFingerprintSighting("fp:v1:restart");
    await recordFiledReport(
      "rpt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "fp:v1:restart",
    );

    // Drop the in-memory handle the way a process restart would.
    __resetReportLedgerForTest({ storePath: storeFile });

    const occurrence = await getFingerprintOccurrence("fp:v1:restart");
    expect(occurrence).toMatchObject({ count: 1 });
    expect(occurrence?.firstSeen).toBe(occurrence?.lastSeen);

    // A second sighting after reload continues the count, not a fresh 1.
    await recordFingerprintSighting("fp:v1:restart");
    expect(await getFingerprintOccurrence("fp:v1:restart")).toMatchObject({
      count: 2,
    });
  });

  it("dedupes filed reports by reportId", async () => {
    await recordFiledReport("rpt_cccccccccccccccccccccccccccccccc", "fp:v1:x");
    await recordFiledReport("rpt_cccccccccccccccccccccccccccccccc", "fp:v1:x");
    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as {
      reports: unknown[];
    };
    expect(raw.reports).toHaveLength(1);
  });

  it("returns null for an unknown fingerprint", async () => {
    expect(await getFingerprintOccurrence("fp:v1:never")).toBeNull();
  });

  it("no-ops empty fingerprint / reportId inputs", async () => {
    await recordFingerprintSighting("");
    await recordFiledReport("", "fp:v1:x");
    await recordFiledReport("rpt_x", "");
    // No file written for pure no-ops that never mutates - or empty state.
    // Either way the occurrence must stay null.
    expect(await getFingerprintOccurrence("fp:v1:x")).toBeNull();
  });

  it("resets a TTL-expired fingerprint to count 1 instead of resurrecting the old count", async () => {
    // Seed a row whose lastSeen is past the 180-day TTL. If the mutator ran
    // before prune, it would increment count 42 → 43 and the post-mutator
    // prune would keep it (lastSeen=now). Prune-before-mutate must treat
    // this as a first sighting again.
    const now = Date.now();
    const stale = now - REPORT_LEDGER_TTL_MS - 1_000;
    writeFileSync(
      storeFile,
      JSON.stringify({
        version: 1,
        fingerprints: {
          "fp:v1:stale": {
            firstSeen: stale - 10_000,
            lastSeen: stale,
            count: 42,
          },
        },
        reports: [],
      }),
      "utf8",
    );
    // Drop the memoized handle so the next mutation reloads from disk.
    __resetReportLedgerForTest({ storePath: storeFile });

    await recordFingerprintSighting("fp:v1:stale");
    const occurrence = await getFingerprintOccurrence("fp:v1:stale");
    expect(occurrence).toMatchObject({ count: 1 });
    // firstSeen must be the fresh sighting, not the pre-TTL value.
    expect(occurrence?.firstSeen).toBeGreaterThan(stale);
    expect(occurrence?.firstSeen).toBe(occurrence?.lastSeen);
  });

  it("getFingerprintOccurrence awaits in-flight mutations (read-after-write)", async () => {
    // Mimic freeze's fire-and-forget: schedule a sighting without awaiting,
    // then immediately read. The read must see count 1, not null/pre-write.
    const write = recordFingerprintSighting("fp:v1:race");
    const occurrence = await getFingerprintOccurrence("fp:v1:race");
    expect(occurrence).toMatchObject({ count: 1 });
    await write;
  });

  it("getFingerprintOccurrence persists TTL eviction so expired rows leave disk", async () => {
    const now = Date.now();
    const stale = now - REPORT_LEDGER_TTL_MS - 1_000;
    writeFileSync(
      storeFile,
      JSON.stringify({
        version: 1,
        fingerprints: {
          "fp:v1:gone": { firstSeen: stale, lastSeen: stale, count: 3 },
          "fp:v1:live": { firstSeen: now - 100, lastSeen: now - 100, count: 1 },
        },
        reports: [],
      }),
      "utf8",
    );
    __resetReportLedgerForTest({ storePath: storeFile });

    expect(await getFingerprintOccurrence("fp:v1:gone")).toBeNull();
    expect(await getFingerprintOccurrence("fp:v1:live")).toMatchObject({
      count: 1,
    });
    await __flushReportLedgerForTest();
    const onDisk = JSON.parse(readFileSync(storeFile, "utf8")) as {
      fingerprints: Record<string, unknown>;
    };
    expect(onDisk.fingerprints["fp:v1:gone"]).toBeUndefined();
    expect(onDisk.fingerprints["fp:v1:live"]).toBeDefined();
  });
});
