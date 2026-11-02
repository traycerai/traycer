import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCrashReportSince } from "../crash-diagnostics";
import {
  buildHostCrashEvent,
  heapSpaceExtraKey,
  type HostCrashTelemetry,
} from "../crash-telemetry";

function resolveNode(): string | null {
  const candidate =
    process.versions.bun === undefined ? process.execPath : "node";
  const probe = spawnSync(candidate, ["-e", "0"]);
  return probe.status === 0 ? candidate : null;
}

const nodeBinary = resolveNode();

describe.skipIf(nodeBinary === null)(
  "heap spaces from a real out-of-memory abort",
  () => {
    let dir = "";
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "crash-heap-spaces-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the per-space heap from the report Node wrote, into the digest and the crash event", async () => {
      if (nodeBinary === null) return;
      const startMs = Date.now();
      spawnSync(
        nodeBinary,
        [
          "--max-old-space-size=32",
          "--report-on-fatalerror",
          `--report-directory=${dir}`,
          "-e",
          "const a=[];for(;;)a.push({x:new Array(100).fill(1)})",
        ],
        { stdio: "ignore", timeout: 60_000 },
      );
      const match = await findCrashReportSince(dir, startMs - 5_000, new Set());
      if (match === null) throw new Error("no diagnostic report was written");

      const spaces = match.memory.heapSpaceUsedBytes;
      const oldSpace = spaces.old_space;
      if (oldSpace === null) throw new Error("old_space missing");
      expect(Number.isInteger(oldSpace)).toBe(true);
      expect(oldSpace).toBeGreaterThan(0);
      expect(Number.isInteger(spaces.large_object_space)).toBe(true);
      expect(Number.isInteger(spaces.new_space)).toBe(true);
      expect(match.memory.heapUsedBytes).not.toBeNull();
      expect(oldSpace).toBeLessThanOrEqual(
        match.memory.heapUsedBytes ?? Number.NEGATIVE_INFINITY,
      );
      expect(match.summary).toContain(`oldSpaceUsedBytes=${oldSpace}`);

      const telemetry: HostCrashTelemetry = {
        environment: "production",
        attemptId: "attempt-1",
        supervisorPid: 1,
        childPid: 2,
        hostVersion: "1.0.0",
        exitCode: null,
        signal: "SIGABRT",
        exitMeaning: null,
        hasDiagnosticReport: true,
        uptimeMs: 100,
        stopRequested: false,
        stderrEmpty: false,
        stderrFatal: "other",
        reportMemory: match.memory,
      };
      const event = buildHostCrashEvent(telemetry, null);
      expect(event.extra[heapSpaceExtraKey("old_space")]).toBe(oldSpace);
    }, 90_000);
  },
);
