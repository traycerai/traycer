import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// In `--json` mode every stdout line must be one NDJSON event. The shared
// client libraries the CLI bundles log through `console.log` / `info` /
// `debug`, which Node writes to stdout - the stream transport's close line
// landed between `traycer login --json`'s events whenever a running host was
// dialed. A real subprocess, because the defect is about which fd a line
// reaches, and the human-mode run is the control that proves the worker logs
// at all.

const WORKER = join(
  import.meta.dirname,
  "fixtures",
  "console-diagnostic-worker.ts",
);

// Spawning bun and compiling the fixture exceeds vitest's default 5s budget
// on a cold cache.
const SPAWN_TIMEOUT_MS = 30_000;

const DIAGNOSTICS = [
  "[lib] log diagnostic",
  "[lib] info diagnostic",
  "[lib] debug diagnostic",
];

interface WorkerRun {
  readonly stdout: string;
  readonly stderr: string;
}

function runWorker(json: boolean): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    execFile(
      "bun",
      ["run", WORKER],
      {
        encoding: "utf8",
        env: { ...process.env, WORKER_JSON: json ? "1" : "0" },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function nonEmptyLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("runner keeps library console output off JSON stdout", () => {
  it(
    "--json: stdout is only NDJSON events and the diagnostics reach stderr",
    async () => {
      const run = await runWorker(true);

      const events = nonEmptyLines(run.stdout).map((line): unknown =>
        JSON.parse(line),
      );
      expect(events).toEqual([
        expect.objectContaining({ type: "progress", message: "probing" }),
        expect.objectContaining({
          type: "result",
          status: "ok",
          data: { ok: true },
        }),
      ]);
      for (const diagnostic of DIAGNOSTICS) {
        expect(run.stderr).toContain(diagnostic);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "human mode (control): the same diagnostics still print on stdout",
    async () => {
      const run = await runWorker(false);

      for (const diagnostic of DIAGNOSTICS) {
        expect(run.stdout).toContain(diagnostic);
      }
      expect(run.stdout).toContain("done");
    },
    SPAWN_TIMEOUT_MS,
  );
});
