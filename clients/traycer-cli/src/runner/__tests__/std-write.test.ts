import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression coverage for the `host available --include-pre-releases`
// truncation (Settings -> Host -> "Pick a different version" reporting
// `traycer-cli emitted no terminal result line`).
//
// The runner emits its terminal NDJSON line and immediately `process.exit()`s.
// `process.stdout.write` is asynchronous on a PIPE, and exit does not drain
// the stream buffer, so before the `std-write` fix only the first 64 KiB (the
// kernel pipe buffer) survived - the rest was dropped and the process still
// exited 0. Desktop saw half a JSON line and no envelope.
//
// Why a real subprocess over a real pipe: the bug lives in the interaction
// between the OS pipe buffer and process teardown. Nothing in-process can
// reproduce it, and neither can a shell redirect to a FILE - file writes are
// synchronous, so `traycer host available --json > out.json` succeeds at any
// size and hides the defect completely. That false-negative is exactly how
// this shipped.
//
// Both payloads run through the identical code path; only the size differs.
// The small case is the control that keeps the large case honest - if the
// worker were silently failing to emit anything at all, both would fail.

const WORKER = join(import.meta.dirname, "fixtures", "large-result-worker.ts");

// macOS and Linux both cap a pipe at 64 KiB. `LARGE` must exceed it by
// enough that a truncated write cannot coincidentally still parse.
const PIPE_BUFFER_BYTES = 65_536;
const SMALL_PAYLOAD_BYTES = 1_024;
const LARGE_PAYLOAD_BYTES = 200_000;

// Spawning bun and compiling the fixture exceeds vitest's default 5s budget
// on a cold cache.
const SPAWN_TIMEOUT_MS = 30_000;

interface WorkerRun {
  readonly stdout: string;
  readonly error: Error | null;
}

// `bun` rather than the vitest host process: the CLI ships as a
// `bun --compile` binary, so bun is the runtime whose flush-on-exit behaviour
// has to hold. (Node truncates identically here, but pinning the shipped
// runtime is what makes this test evidence about the artifact we release.)
function runWorker(payloadBytes: number): Promise<WorkerRun> {
  return new Promise((resolve) => {
    execFile(
      "bun",
      ["run", WORKER],
      {
        encoding: "utf8",
        // Well above LARGE so a maxBuffer kill can never be mistaken for
        // the truncation this test is about.
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WORKER_PAYLOAD_BYTES: String(payloadBytes) },
      },
      (error, stdout) => {
        resolve({ stdout: String(stdout), error });
      },
    );
  });
}

function terminalResultOf(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated terminal line lands here - that IS the bug, so fall
      // through and let the caller's assertion report the miss.
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { type: unknown }).type === "result"
    ) {
      return parsed;
    }
  }
  return null;
}

describe("runner stdout survives process.exit", () => {
  it(
    "delivers a terminal result line larger than the 64 KiB pipe buffer",
    async () => {
      // Guard on the CONSTANT, not on observed stdout: this is what keeps
      // the test meaningful if the payload is ever tuned down, and unlike
      // an assertion on `run.stdout.length` it stays independent of the
      // defect under test (a truncated run lands at exactly 65,536 bytes,
      // which would report as a byte-count mismatch rather than as the
      // missing envelope that actually breaks Desktop).
      expect(LARGE_PAYLOAD_BYTES).toBeGreaterThan(PIPE_BUFFER_BYTES);

      const run = await runWorker(LARGE_PAYLOAD_BYTES);
      expect(run.error).toBeNull();

      const terminal = terminalResultOf(run.stdout);
      expect(terminal).not.toBeNull();
      expect(terminal).toMatchObject({ type: "result", status: "ok" });
      // Not just parseable - complete. A write cut at the pipe boundary
      // would still be 65,536 bytes of valid-looking prefix.
      expect(
        (terminal as { data: { filler: string } }).data.filler.length,
      ).toBe(LARGE_PAYLOAD_BYTES);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "delivers a terminal result line smaller than the pipe buffer",
    async () => {
      const run = await runWorker(SMALL_PAYLOAD_BYTES);

      expect(run.error).toBeNull();
      expect(run.stdout.length).toBeLessThan(PIPE_BUFFER_BYTES);

      const terminal = terminalResultOf(run.stdout);
      expect(terminal).toMatchObject({ type: "result", status: "ok" });
      expect(
        (terminal as { data: { filler: string } }).data.filler.length,
      ).toBe(SMALL_PAYLOAD_BYTES);
    },
    SPAWN_TIMEOUT_MS,
  );
});
