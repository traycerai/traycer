import { app } from "electron";
import { join } from "node:path";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "./json-file-store";
import { log } from "./logger";

/**
 * Never renderer localStorage: `lib/persist/wipe.ts` sweeps every `traycer-gui-app:` key on logout, and those keys are identity-scoped while this ledger is install- scoped.
 * Copy that consumes these numbers must say "on this install".
 */

const STORE_FILE_NAME = "report-ledger.json";
const STORE_VERSION = 1 as const;

/** Cap each collection so a crash-looping install cannot grow the file unboundedly. */
export const REPORT_LEDGER_MAX_FINGERPRINTS = 500;
export const REPORT_LEDGER_MAX_REPORTS = 500;

/** Drop entries older than this, measured against lastSeen / timestamp. */
export const REPORT_LEDGER_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export interface FingerprintSighting {
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
}

export interface FiledReportEntry {
  readonly reportId: string;
  readonly fingerprint: string;
  readonly timestamp: number;
}

export interface ReportLedgerState {
  readonly version: typeof STORE_VERSION;
  /** fingerprint -> sighting stats. Object (not Map) for JSON stability. */
  readonly fingerprints: Readonly<Record<string, FingerprintSighting>>;
  readonly reports: readonly FiledReportEntry[];
}

export interface FingerprintOccurrence {
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
}

const EMPTY_STATE: ReportLedgerState = {
  version: STORE_VERSION,
  fingerprints: {},
  reports: [],
};

let store: StrictJsonFileStore<ReportLedgerState> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

/** Test-only override so suites can point the store at a temp directory. */
let storePathOverride: string | null = null;

function storePath(): string {
  if (storePathOverride !== null) return storePathOverride;
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

function getStore(): StrictJsonFileStore<ReportLedgerState> {
  store ??= createJsonFileStore<ReportLedgerState>(
    storePath(),
    EMPTY_STATE,
    parseReportLedgerState,
  );
  return store;
}

export function parseReportLedgerState(value: unknown): ReportLedgerState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_STATE;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION) return EMPTY_STATE;
  if (
    record.fingerprints === null ||
    typeof record.fingerprints !== "object" ||
    Array.isArray(record.fingerprints)
  ) {
    return EMPTY_STATE;
  }
  if (!Array.isArray(record.reports)) return EMPTY_STATE;

  const fingerprints: Record<string, FingerprintSighting> = {};
  for (const [key, raw] of Object.entries(
    record.fingerprints as Record<string, unknown>,
  )) {
    const sighting = parseSighting(raw);
    if (sighting !== null) fingerprints[key] = sighting;
  }

  const reports: FiledReportEntry[] = [];
  for (const raw of record.reports) {
    const entry = parseFiledReport(raw);
    if (entry !== null) reports.push(entry);
  }

  return { version: STORE_VERSION, fingerprints, reports };
}

function parseSighting(value: unknown): FingerprintSighting | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.firstSeen !== "number" ||
    !Number.isFinite(record.firstSeen) ||
    typeof record.lastSeen !== "number" ||
    !Number.isFinite(record.lastSeen) ||
    typeof record.count !== "number" ||
    !Number.isInteger(record.count) ||
    record.count < 1
  ) {
    return null;
  }
  return {
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    count: record.count,
  };
}

function parseFiledReport(value: unknown): FiledReportEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.reportId !== "string" ||
    record.reportId.length === 0 ||
    typeof record.fingerprint !== "string" ||
    record.fingerprint.length === 0 ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp)
  ) {
    return null;
  }
  return {
    reportId: record.reportId,
    fingerprint: record.fingerprint,
    timestamp: record.timestamp,
  };
}

export function pruneReportLedgerState(
  state: ReportLedgerState,
  nowMs: number,
  options: {
    readonly maxFingerprints: number;
    readonly maxReports: number;
    readonly ttlMs: number;
  },
): ReportLedgerState {
  const cutoff = nowMs - options.ttlMs;

  const fingerprints: Record<string, FingerprintSighting> = {};
  for (const [key, sighting] of Object.entries(state.fingerprints)) {
    if (sighting.lastSeen >= cutoff) {
      fingerprints[key] = sighting;
    }
  }

  let fingerprintEntries = Object.entries(fingerprints);
  if (fingerprintEntries.length > options.maxFingerprints) {
    fingerprintEntries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    fingerprintEntries = fingerprintEntries.slice(
      fingerprintEntries.length - options.maxFingerprints,
    );
  }
  const prunedFingerprints: Record<string, FingerprintSighting> = {};
  for (const [key, sighting] of fingerprintEntries) {
    prunedFingerprints[key] = sighting;
  }

  let reports = state.reports.filter((entry) => entry.timestamp >= cutoff);
  if (reports.length > options.maxReports) {
    // Keep the most recent `maxReports` by timestamp (stable on ties by index).
    const indexed = reports.map((entry, index) => ({ entry, index }));
    indexed.sort((a, b) => {
      const byTime = a.entry.timestamp - b.entry.timestamp;
      return byTime !== 0 ? byTime : a.index - b.index;
    });
    reports = indexed
      .slice(indexed.length - options.maxReports)
      .map((item) => item.entry);
  }

  return {
    version: STORE_VERSION,
    fingerprints: prunedFingerprints,
    reports,
  };
}

function defaultBounds() {
  return {
    maxFingerprints: REPORT_LEDGER_MAX_FINGERPRINTS,
    maxReports: REPORT_LEDGER_MAX_REPORTS,
    ttlMs: REPORT_LEDGER_TTL_MS,
  };
}

function applyMutation(
  mutator: (state: ReportLedgerState, nowMs: number) => ReportLedgerState,
): Promise<void> {
  const run = mutationQueue.then(async () => {
    const loaded = await getStore().load();
    const nowMs = Date.now();
    // Prune BEFORE the mutator so a >TTL-stale row cannot be resurrected
    // with its pre-expiry count ("Nth time" for an expired defect). Cap
    // prune also runs after so a mutator that inserts still respects bounds.
    const current = pruneReportLedgerState(loaded, nowMs, defaultBounds());
    const next = pruneReportLedgerState(
      mutator(current, nowMs),
      nowMs,
      defaultBounds(),
    );
    await getStore().save(next);
  });
  mutationQueue = run.then(
    () => undefined,
    (err: unknown) => {
      log.warn("[report-ledger] mutation failed", { err });
    },
  );
  return mutationQueue;
}

/**
 * Best-effort: a disk failure is logged and swallowed so a ledger blip never blocks freeze / dialog open.
 * Callers must treat an expired-and-gone row as a fresh first sighting (count 1).
 */
export function recordFingerprintSighting(fingerprint: string): Promise<void> {
  if (fingerprint.length === 0) return Promise.resolve();
  return applyMutation((state, nowMs) => {
    const existing = state.fingerprints[fingerprint];
    const nextSighting: FingerprintSighting =
      existing === undefined
        ? { firstSeen: nowMs, lastSeen: nowMs, count: 1 }
        : {
            firstSeen: existing.firstSeen,
            lastSeen: nowMs,
            count: existing.count + 1,
          };
    return {
      ...state,
      fingerprints: {
        ...state.fingerprints,
        [fingerprint]: nextSighting,
      },
    };
  });
}

/** Only call on `{ status: "delivered", reportId }` - never on unconfirmed/failed/unavailable. */
export function recordFiledReport(
  reportId: string,
  fingerprint: string,
): Promise<void> {
  if (reportId.length === 0 || fingerprint.length === 0) {
    return Promise.resolve();
  }
  return applyMutation((state, nowMs) => {
    // De-dupe by reportId: a retry that somehow re-reports delivered must not
    // double-insert. (Normal retries reuse the same reportId under T2.)
    if (state.reports.some((entry) => entry.reportId === reportId)) {
      return state;
    }
    return {
      ...state,
      reports: [...state.reports, { reportId, fingerprint, timestamp: nowMs }],
    };
  });
}

/** Returns null when this fingerprint has never been sighted here. */
export async function getFingerprintOccurrence(
  fingerprint: string,
): Promise<FingerprintOccurrence | null> {
  if (fingerprint.length === 0) return null;
  await mutationQueue;
  const loaded = await getStore().load();
  const nowMs = Date.now();
  const state = pruneReportLedgerState(loaded, nowMs, defaultBounds());
  // Route it through applyMutation so a concurrent sighting cannot be overwritten by this read's stale snapshot, and so a cleanup write failure stays best-effort instead of rejecting.
  if (
    Object.keys(state.fingerprints).length !==
      Object.keys(loaded.fingerprints).length ||
    state.reports.length !== loaded.reports.length
  ) {
    await applyMutation((current) => current);
  }
  const sighting = state.fingerprints[fingerprint];
  if (sighting === undefined) return null;
  return {
    firstSeen: sighting.firstSeen,
    lastSeen: sighting.lastSeen,
    count: sighting.count,
  };
}

/** Production never calls this. */
export function __resetReportLedgerForTest(options: {
  readonly storePath: string | null;
}): void {
  store = null;
  mutationQueue = Promise.resolve();
  storePathOverride = options.storePath;
}

export function __flushReportLedgerForTest(): Promise<void> {
  return mutationQueue;
}
