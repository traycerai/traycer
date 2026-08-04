import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  writeBootstrapTerminalMarker,
  readBootstrapMarkers,
} = await import("../bootstrap-log");

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
