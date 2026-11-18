import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression coverage for Sentry TRAYCER-CLI-25 (`Error: write EPIPE`, fatal).
//
// When the reader of the CLI's stdout/stderr closes its end of the pipe
// (`traycer ... | head -1`, a desktop that gave up on the child), the next
// write fails with EPIPE. `std-write` already settles the write's callback on
// that error, but Node ALSO emits `error` on the stream, and an `error` event
// with no listener is thrown as an uncaught exception - the CLI died with
// exit 1 over a reader that had simply gone away.
//
// Real subprocess over a real pipe, for the same reason as `std-write.test.ts`:
// the failure is the interaction between a closed pipe and the stream's error
// event, which nothing in-process reproduces.
//
// Under NODE, not bun (unlike `std-write.test.ts`): bun does not emit the
// stream `error` event on a closed reader, so the same worker exits 0 there
// with or without the fix and proves nothing. The released CLI is a Node SEA,
// which is where Sentry saw the crash. The worker is bundled with esbuild
// first because Node cannot resolve its extensionless TypeScript imports.

const FIXTURES = join(import.meta.dirname, "fixtures");
const WORKER_SOURCE = join(FIXTURES, "closed-reader-worker.ts");
const FOLLOW_WORKER_SOURCE = join(FIXTURES, "follow-reader-worker.ts");
const BYPASS_WORKER_SOURCE = join(FIXTURES, "bypass-writer-worker.ts");

// Bundling the fixture and spawning node can exceed vitest's default 5s
// budget on a cold cache.
const SPAWN_TIMEOUT_MS = 30_000;

type WorkerStream = "stdout" | "stderr";

interface WorkerRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

interface WorkerOptions {
  readonly stream: WorkerStream;
  /** Close the parent's read end of `stream` once the first line arrives. */
  readonly closeReader: boolean;
  readonly injectErrorCode: string | null;
  /**
   * `"after-guard"`: the worker installs its own `error` listener after the
   * guards, before its first write. `"once-before-guard"`: a `once("error")`
   * listener registered BEFORE the guards. `null`: none.
   */
  readonly ownErrorListener: "after-guard" | "once-before-guard" | null;
}

let bundleDir = "";
let workerBundle = "";
let followWorkerBundle = "";
let bypassWorkerBundle = "";

async function bundleWorker(source: string, name: string): Promise<string> {
  const outfile = join(bundleDir, name);
  await build({
    entryPoints: [source],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  return outfile;
}

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "std-write-closed-reader-"));
  workerBundle = await bundleWorker(WORKER_SOURCE, "closed-reader-worker.mjs");
  followWorkerBundle = await bundleWorker(
    FOLLOW_WORKER_SOURCE,
    "follow-reader-worker.mjs",
  );
  bypassWorkerBundle = await bundleWorker(
    BYPASS_WORKER_SOURCE,
    "bypass-writer-worker.mjs",
  );
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
  if (bundleDir.length > 0) {
    await rm(bundleDir, { recursive: true, force: true });
  }
});

function runWorker(options: WorkerOptions): Promise<WorkerRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerBundle], {
      env: {
        ...process.env,
        WORKER_STREAM: options.stream,
        WORKER_INJECT_ERROR_CODE: options.injectErrorCode ?? "",
        WORKER_OWN_ERROR_LISTENER: options.ownErrorListener ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr += text;
    });
    // The worker's stdout is only ever drained, never read.
    child.stdout.resume();

    if (options.closeReader) {
      const reader = options.stream === "stdout" ? child.stdout : child.stderr;
      reader.once("data", () => {
        reader.destroy();
      });
    }

    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

describe("std-write survives a reader that closed the pipe", () => {
  it.each<WorkerStream>(["stdout", "stderr"])(
    "exits 0 when the %s reader closes mid-stream",
    async (stream) => {
      const run = await runWorker({
        stream,
        closeReader: true,
        injectErrorCode: null,
        ownErrorListener: null,
      });

      // A stderr reader that is gone cannot show us the crash text, so the
      // exit status is the claim; the text check is for the stdout case,
      // where it is still readable.
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(run.stderr).not.toContain("Unhandled 'error' event");
      expect(run.stderr).not.toContain("EPIPE");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "still crashes on a stream error that is not a closed reader",
    async () => {
      const run = await runWorker({
        stream: "stdout",
        closeReader: false,
        injectErrorCode: "EIO",
        ownErrorListener: null,
      });

      // Swallowing EIO (or any other code) would hide a genuinely broken
      // descriptor; only EPIPE means "nobody is listening any more". The
      // error comes out of the stream's own failing write, not a hand-emitted
      // event.
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("injected stream error");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "leaves a stream error to another listener that already owns it",
    async () => {
      // `acknowledgeRelocationEntry` installs a no-op `error` listener on a
      // relocated host-stopping command so the EIO from its closed PTY cannot
      // kill the update. EventEmitter runs every listener, so ours must not
      // rethrow what that one has already taken responsibility for.
      const run = await runWorker({
        stream: "stdout",
        closeReader: false,
        injectErrorCode: "EIO",
        ownErrorListener: "after-guard",
      });

      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(run.stderr).not.toContain("injected stream error");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "does not rethrow an error a once-listener registered before the guard has handled",
    async () => {
      // Node removes a `once` listener BEFORE calling it, so by the time the
      // guard runs the listener count has already dropped to 1. The guard
      // must run first (prependListener) and count that listener.
      const run = await runWorker({
        stream: "stdout",
        closeReader: false,
        injectErrorCode: "EIO",
        ownErrorListener: "once-before-guard",
      });

      expect(run.stderr).toContain("once-handler saw EIO");
      expect(run.stderr).not.toContain("injected stream error");
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});

// How long the follow-style worker may outlive its reader before the test
// gives up on it and kills it; the claim is that it exits well inside this.
const FOLLOW_KILL_AFTER_MS = 5_000;
const FOLLOW_EXIT_BUDGET_MS = 3_000;

interface ClosedReaderRun extends WorkerRun {
  /** From the parent destroying its read end to the child's exit. */
  readonly msAfterReaderClosed: number;
  /** The test had to kill the worker: it was still running. */
  readonly killed: boolean;
}

/**
 * Spawns `bundle`, destroys the parent's read end of the worker's stdout on
 * the first line, and waits for the worker to exit - killing it once it has
 * outlived its reader by `FOLLOW_KILL_AFTER_MS`.
 */
function runWithStdoutReaderClosed(bundle: string): Promise<ClosedReaderRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr += text;
    });

    let readerClosedAt: number | null = null;
    let killed = false;
    let killTimer: NodeJS.Timeout | null = null;
    child.stdout.once("data", () => {
      child.stdout.destroy();
      readerClosedAt = Date.now();
      killTimer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, FOLLOW_KILL_AFTER_MS);
    });

    child.once("close", (code, signal) => {
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stderr,
        killed,
        msAfterReaderClosed:
          readerClosedAt === null ? -1 : Date.now() - readerClosedAt,
      });
    });
  });
}

describe("a closed stdout reader ends a streaming command", () => {
  it(
    "a follow-style stream exits 0 once its stdout reader is gone",
    async () => {
      // `traycer host logs --follow | head -20`: with the EPIPE absorbed,
      // nothing used to end the follow but a signal, so it polled and wrote
      // into a dead pipe for ever. `stdoutReaderClosed()` is what it ends on.
      const run = await runWithStdoutReaderClosed(followWorkerBundle);

      expect(run.killed).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(run.msAfterReaderClosed).toBeGreaterThanOrEqual(0);
      expect(run.msAfterReaderClosed).toBeLessThan(FOLLOW_EXIT_BUDGET_MS);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a writer that bypasses std-write survives a closed reader once the entry guards are installed",
    async () => {
      // The maintenance-lease protocol frames and worktree-delete's relayed
      // output write with bare `process.stdout.write`; nothing goes through
      // `std-write`, so a guard attached on the first write through it never
      // existed for them.
      const run = await runWithStdoutReaderClosed(bypassWorkerBundle);

      expect(run.killed).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.stderr).not.toContain("Unhandled 'error' event");
      expect(run.code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
