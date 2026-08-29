import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireUpdateAttemptLock } from "../../lock";

const BARRIER_POLL_MS = 20;
const BARRIER_MAX_WAIT_MS = 30_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + BARRIER_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const exists = await stat(path)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
  }
  throw new Error(`lock-worker: timed out waiting for ${path}`);
}

// Worker process for `lock.test.ts`'s genuine two-process
// `update-attempt.lock` contention test. Spawned as a real, separate OS
// process (via `bun run`) so the test proves `acquireUpdateAttemptLock`
// contends across actual processes, not merely across in-process promises -
// the README's `held-in-process` distinction only means anything if `busy`
// is exercised against a REAL other holder.
//
// Protocol: acquire the canonical lock under `WORKER_HOST_HOME_DIR`. On
// success, write `<barrierDir>/held` with this process's pid and the lock
// token it was granted, then block until `<barrierDir>/release` appears
// before releasing and writing `<barrierDir>/released`. On contention, write
// `<barrierDir>/busy` with the observed holder (or `null`) and exit.
async function main(): Promise<void> {
  const hostHomeDir = process.env.WORKER_HOST_HOME_DIR;
  const barrierDir = process.env.WORKER_BARRIER_DIR;
  const waitMs = process.env.WORKER_WAIT_MS;
  if (
    hostHomeDir === undefined ||
    barrierDir === undefined ||
    waitMs === undefined
  ) {
    throw new Error(
      "lock-worker: WORKER_HOST_HOME_DIR, WORKER_BARRIER_DIR, and WORKER_WAIT_MS are required",
    );
  }

  const outcome = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason: "lock-worker",
    waitMs: Number(waitMs),
    pollIntervalMs: 25,
  });

  if (outcome.kind === "busy") {
    await writeFile(
      join(barrierDir, "busy"),
      JSON.stringify({ holder: outcome.holder }),
    );
    return;
  }
  if (outcome.kind === "held-in-process") {
    throw new Error(
      "lock-worker: unexpected held-in-process in a fresh process",
    );
  }

  await writeFile(
    join(barrierDir, "held"),
    JSON.stringify({ pid: process.pid, token: outcome.handle.metadata.token }),
  );
  await waitForFile(join(barrierDir, "release"));
  await outcome.handle.release();
  await writeFile(join(barrierDir, "released"), "");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`lock-worker failed: ${String(err)}\n`);
    process.exit(1);
  });
