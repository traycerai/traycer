import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Integration counterpart to the fake-child unit tests in
// `traycer-cli-envelope.test.ts`: a REAL subprocess, REAL pipes and REAL
// timers, so this proves the wiring end to end rather than the timer
// arithmetic in isolation.
//
// The regression it guards is traycer#585/#589: `CLI_STREAM_TIMEOUT_MS` was
// an absolute ceiling, so Desktop SIGKILLed the CLI 10 minutes into a host
// download that was still transferring - which is why a 700MB+ archive
// could never install on a slow link. The budget is now inactivity, and a
// child that keeps reporting must survive past it.

const scriptDir = mkdtempSync(join(tmpdir(), "traycer-cli-idle-itest-"));

vi.mock("../cli-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-discovery")>();
  return {
    ...actual,
    discoverCli: async () => ({
      kind: "manifest" as const,
      binaryPath: join(scriptDir, "fake-cli.mjs"),
      version: "1.1.8-rc.2",
    }),
    resolveBundledCliPath: async () => join(scriptDir, "fake-cli.mjs"),
  };
});

import { streamTraycerCliJson } from "../traycer-cli";

// Stands in for `traycer host download --json`: emits NDJSON progress on a
// tick, then a terminal ok. `node` runs it directly (the shebang keeps it
// spawnable as a bare command path).
function writeFakeCli(opts: {
  readonly tickMs: number;
  readonly ticks: number;
  readonly trailingSilenceMs: number;
  readonly exitAfterSilence: boolean;
}): void {
  const script = `#!/usr/bin/env node
const tickMs = ${opts.tickMs};
const ticks = ${opts.ticks};
const trailingSilenceMs = ${opts.trailingSilenceMs};
const exitAfterSilence = ${String(opts.exitAfterSilence)};
let sent = 0;
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
// The real CLI reports its first stage as soon as the command body starts
// (\`resolve\`, before any transfer), so the budget only ever has to cover
// process startup - never a whole transfer.
emit({
  type: "progress",
  stage: "resolve",
  percent: null,
  bytes: null,
  totalBytes: null,
  message: "resolving host 1.1.8-rc.2",
  timestamp: new Date().toISOString(),
});
const timer = setInterval(() => {
  sent += 1;
  emit({
    type: "progress",
    stage: "download",
    percent: Math.round((sent / ticks) * 100),
    bytes: sent * 1024 * 1024,
    totalBytes: ticks * 1024 * 1024,
    message: "downloading host 1.1.8-rc.2",
    timestamp: new Date().toISOString(),
  });
  if (sent >= ticks) {
    clearInterval(timer);
    setTimeout(() => {
      if (exitAfterSilence) {
        emit({ type: "result", status: "ok", data: { version: "1.1.8-rc.2" } });
        process.exit(0);
      }
      // Otherwise hang forever: the idle budget is the only thing that can
      // end this process.
      setInterval(() => undefined, 1000);
    }, trailingSilenceMs);
  }
}, tickMs);
`;
  const path = join(scriptDir, "fake-cli.mjs");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
}

beforeAll(() => {
  process.env.TRAYCER_TEST_FAKE_CLI = "1";
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
});

describe("streamTraycerCliJson idle budget against a real subprocess", () => {
  it("keeps a child alive far past the budget while it keeps reporting", async () => {
    // 15 ticks x 200ms = 3s of runtime under a 1.2s budget. Under the old
    // absolute-ceiling semantics this child would have been SIGKILLed at
    // 1.2s with progress still flowing - the exact shape of the reported
    // failure, just compressed in time.
    writeFakeCli({
      tickMs: 200,
      ticks: 15,
      trailingSilenceMs: 0,
      exitAfterSilence: true,
    });
    const progress: number[] = [];
    const started = Date.now();
    const result = await streamTraycerCliJson<{ version: string }>({
      args: ["host", "download", "--automatic"],
      onEvent: (event) => {
        if (event.type === "progress" && event.percent !== null) {
          progress.push(event.percent);
        }
      },
      env: null,
      idleTimeoutMs: 1_200,
      signal: null,
    });
    const elapsed = Date.now() - started;

    expect(result.data.version).toBe("1.1.8-rc.2");
    expect(progress).toHaveLength(15);
    expect(elapsed).toBeGreaterThan(2_500);
  }, 30_000);

  it("kills a child that stops reporting, once the budget elapses", async () => {
    writeFakeCli({
      tickMs: 100,
      ticks: 3,
      trailingSilenceMs: 0,
      exitAfterSilence: false,
    });
    const started = Date.now();
    await expect(
      streamTraycerCliJson<unknown>({
        args: ["host", "download", "--automatic"],
        onEvent: () => undefined,
        env: null,
        idleTimeoutMs: 700,
        signal: null,
      }),
    ).rejects.toThrow("produced no output for 700ms");
    const elapsed = Date.now() - started;

    // Killed only after the last event plus the budget, never before.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 20_000);
});
