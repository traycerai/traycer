import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StderrCaptureBuffer } from "../crash-diagnostics";

const mocks = vi.hoisted(() => ({
  logPath: "",
  homeDir: "",
}));

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: () => mocks.logPath,
  hostHomeDir: () => mocks.homeDir,
  ensureHostHomeDir: async () => {
    // No-op: the test creates the parent of logPath.
  },
}));

const {
  parseBootstrapLogLine,
  writeBootstrapMarker,
  writeBootstrapTerminalMarker,
  readBootstrapMarkers,
  retainAuthenticMarkers,
  markersIdentifyWriter,
} = await import("../bootstrap-log");

const NO_FIELDS = {
  shell: undefined,
  args: undefined,
  bundle: undefined,
  exitCode: undefined,
  signal: undefined,
  error: undefined,
  exitMeaning: undefined,
  report: undefined,
  stderrTail: undefined,
  attemptId: undefined,
  supervisorPid: undefined,
} as const;

describe("bootstrap-log crash diagnostic fields", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "traycer-bootstrap-log-"));
    mocks.homeDir = root;
    mocks.logPath = join(root, "host.log");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("formatFields renders exitMeaning, report, and stderrTail and parse round-trips them", async () => {
    const stderrTail =
      "FATAL ERROR: Reached heap limit\\nAllocation failed - JavaScript heap out of memory";
    writeBootstrapTerminalMarker("production", "crashed", {
      shell: undefined,
      args: undefined,
      bundle: "/opt/traycer/host/install/traycer-host",
      exitCode: 3221226505,
      signal: undefined,
      error: undefined,
      exitMeaning:
        "0xC0000409 STATUS_STACK_BUFFER_OVERRUN (fail-fast abort: V8 fatal/OOM, native stack overflow, or CRT abort)",
      report: "report.2026-01-01.120000.1234.0.001.json",
      stderrTail,
      attemptId: "attempt-uuid",
      supervisorPid: 42,
    });

    const raw = await readFile(mocks.logPath, "utf8");
    const line = raw.trimEnd();
    expect(line).toContain("phase=crashed");
    expect(line).toContain("code=3221226505");
    expect(line).toContain("exitMeaning=");
    expect(line).toContain("0xC0000409");
    expect(line).toContain("report=report.2026-01-01.120000.1234.0.001.json");
    expect(line).toMatch(/stderrTail="/);

    const parsed = parseBootstrapLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.phase).toBe("crashed");
    expect(parsed?.fields.code).toBe("3221226505");
    expect(parsed?.fields.exitMeaning).toContain("0xC0000409");
    expect(parsed?.fields.report).toBe(
      "report.2026-01-01.120000.1234.0.001.json",
    );
    expect(parsed?.fields.stderrTail).toBe(stderrTail);
    expect(parsed?.fields.attempt).toBe("attempt-uuid");
    expect(parsed?.fields.supervisorPid).toBe("42");
  });

  it("round-trips a stderrTail that contained U+2028/U+2029 after capture escape", async () => {
    // Repro from cold review: a raw U+2028 inside a quoted marker value
    // silently discards the whole marker line. Capture must escape it first.
    const capture = new StderrCaptureBuffer(2048, 2048);
    capture.append(Buffer.from("FATAL\u2028ERROR\u2029block\nnext"));
    const stderrTail = capture.escapedForMarker();
    expect(stderrTail).toBe("FATAL\\nERROR\\nblock\\nnext");
    expect(stderrTail).not.toMatch(/[\u2028\u2029]/);

    writeBootstrapTerminalMarker("production", "crashed", {
      shell: undefined,
      args: undefined,
      bundle: undefined,
      exitCode: 1,
      signal: undefined,
      error: undefined,
      exitMeaning: undefined,
      report: undefined,
      stderrTail,
      attemptId: "a",
      supervisorPid: 1,
    });

    const raw = await readFile(mocks.logPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    // The marker must be a SINGLE parseable line (U+2028 must not split it).
    expect(lines).toHaveLength(1);
    const parsed = parseBootstrapLogLine(lines[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed?.phase).toBe("crashed");
    expect(parsed?.fields.stderrTail).toBe(stderrTail);
  });

  it("parses legacy markers that lack the crash-diagnostic keys", () => {
    const line =
      "[2026-01-01T00:00:00.000Z] phase=crashed code=7 attempt=a1 supervisorPid=9";
    const parsed = parseBootstrapLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.phase).toBe("crashed");
    expect(parsed?.fields.code).toBe("7");
    expect(parsed?.fields.exitMeaning).toBeUndefined();
    expect(parsed?.fields.report).toBeUndefined();
    expect(parsed?.fields.stderrTail).toBeUndefined();
    expect(parsed?.fields.attempt).toBe("a1");
  });

  it("readBootstrapMarkers surfaces the new fields as strings", async () => {
    writeBootstrapTerminalMarker("production", "crashed", {
      shell: undefined,
      args: undefined,
      bundle: undefined,
      exitCode: 1,
      signal: undefined,
      error: undefined,
      exitMeaning: "0xC0000005 STATUS_ACCESS_VIOLATION (native crash)",
      report: "r.json",
      stderrTail: "segv",
      attemptId: undefined,
      supervisorPid: undefined,
    });

    const entries = await readBootstrapMarkers("production", 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fields.exitMeaning).toContain("0xC0000005");
    expect(entries[0]?.fields.report).toBe("r.json");
    expect(entries[0]?.fields.stderrTail).toBe("segv");
  });
});

// `host.log` is both the marker destination and the child's stderr sink, so
// a host line shaped like a marker used to parse as one. See the writer-field
// contract at the top of `bootstrap-log.ts`.
describe("bootstrap-log writer identity", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "traycer-bootstrap-writer-"));
    mocks.homeDir = root;
    mocks.logPath = join(root, "host.log");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stamps writer=supervisor from BOTH writers", async () => {
    // Both paths must stamp it: the guarantee is "every marker carries it",
    // and one unstamped writer would mint markers its own parser rejects.
    await writeBootstrapMarker("production", "starting", NO_FIELDS);
    writeBootstrapTerminalMarker("production", "crashed", NO_FIELDS);

    const lines = (await readFile(mocks.logPath, "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("writer=supervisor");
      expect(parseBootstrapLogLine(line)?.writer).toBe("supervisor");
    }
  });

  it("labels a marker-shaped line with no writer field as unverified", () => {
    const forged = "[2026-01-01T00:00:00.000Z] phase=starting";
    expect(parseBootstrapLogLine(forged)?.writer).toBe("unverified");
    // Still parsed, not dropped - one line cannot tell an older CLI's
    // marker from host output wearing the grammar.
    expect(parseBootstrapLogLine(forged)?.phase).toBe("starting");
  });

  it("drops host output that mimics a marker once the writer is identified", async () => {
    // The reported defect: this `starting` line is the host's own stderr,
    // and Doctor's `lastCrashMarker` treats a later `starting` as proof the
    // host recovered - so it cancelled a real crash and reported clean.
    writeBootstrapTerminalMarker("production", "crashed", {
      ...NO_FIELDS,
      exitCode: 134,
    });
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:00.000Z] phase=starting\n",
    );

    const entries = await readBootstrapMarkers("production", 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.phase).toBe("crashed");
    expect(entries.some((e) => e.phase === "starting")).toBe(false);
  });

  it("keeps the previous CLI's crash markers across an upgrade", async () => {
    // The ordinary upgrade path: an old CLI recorded a real crash, the user
    // upgrades, and the next start stamps a marker into the SAME log. A
    // whole-file rule would let that stamped marker retroactively delete
    // the older crash - on every upgrade, not in some rare corner.
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:00.000Z] phase=crashed code=139\n",
    );
    await writeBootstrapMarker("production", "starting", NO_FIELDS);

    const entries = await readBootstrapMarkers("production", 10);
    expect(entries.map((e) => e.phase)).toEqual(["crashed", "starting"]);
    expect(entries[0]?.writer).toBe("unverified");
    expect(entries[1]?.writer).toBe("supervisor");
  });

  it("still rejects mimicry that arrives after the first stamped marker", async () => {
    // The other side of the same boundary: preserving the leading legacy
    // block must not re-admit host output that lands AFTER the writer has
    // proven it stamps its markers.
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:00.000Z] phase=crashed code=139\n",
    );
    await writeBootstrapMarker("production", "starting", NO_FIELDS);
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:09.000Z] phase=exited code=0\n",
    );

    const entries = await readBootstrapMarkers("production", 10);
    expect(entries.map((e) => e.phase)).toEqual(["crashed", "starting"]);
  });

  it("keeps every marker in a log no verified writer has touched", async () => {
    // N-1: an older CLI stamped nothing, so strictness here would blind
    // Doctor to a crash it genuinely recorded. Byte-identical to the old
    // behaviour, including the `starting` that cancels the crash.
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:00.000Z] phase=crashed code=7\n" +
        "[2026-01-01T00:00:01.000Z] phase=starting\n",
    );

    const entries = await readBootstrapMarkers("production", 10);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.phase)).toEqual(["crashed", "starting"]);
    expect(entries.every((e) => e.writer === "unverified")).toBe(true);
  });

  it("decides the era from the whole file, not the requested tail", async () => {
    // Latch-then-slice. Slicing first would judge the era from the last N
    // lines, so a burst of mimicking output at the end of an upgraded log
    // would read as legacy and be trusted.
    writeBootstrapTerminalMarker("production", "crashed", {
      ...NO_FIELDS,
      exitCode: 9,
    });
    await appendFile(
      mocks.logPath,
      "[2026-01-01T00:00:01.000Z] phase=starting\n" +
        "[2026-01-01T00:00:02.000Z] phase=starting\n",
    );

    const entries = await readBootstrapMarkers("production", 2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.phase).toBe("crashed");
  });

  it("keeps nothing when a capped window drops the verified marker", () => {
    // Capability is monotonic, so `retainAuthenticMarkers` takes the bit
    // rather than re-deriving it: a caller holding a truncated window that
    // no longer contains the verified marker must stay strict.
    const unverifiedOnly = [
      "[2026-01-01T00:00:01.000Z] phase=starting",
      "[2026-01-01T00:00:02.000Z] phase=starting",
    ].map((line) => parseBootstrapLogLine(line)!);

    expect(markersIdentifyWriter(unverifiedOnly)).toBe(false);
    // Re-deriving the bit here would return both lines - the reopened hole.
    expect(retainAuthenticMarkers(unverifiedOnly, true)).toHaveLength(0);
    expect(retainAuthenticMarkers(unverifiedOnly, false)).toHaveLength(2);
  });
});
