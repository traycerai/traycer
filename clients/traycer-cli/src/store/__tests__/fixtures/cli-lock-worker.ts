import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __acquireCliLockAtPathForTest } from "../../cli-lock";

const BARRIER_POLL_MS = 20;
const BARRIER_MAX_WAIT_MS = 15_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + BARRIER_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const exists = await stat(path)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
  }
  throw new Error(`cli-lock-worker: timed out waiting for ${path}`);
}

// Worker process for the genuine multiprocess break-arbitration regression
// test in `cli-lock.test.ts`. Spawned as a real, separate OS process (via
// `bun run`) so the test exercises actual cross-process contention on the
// lock file, not an in-process simulation. Reads its configuration from env
// vars (there is no other channel into a freshly-spawned process) and
// implements a "held marker" protocol: while it believes it holds the
// lock, it writes `held-<label>.marker` into `WORKER_MARKER_DIR` and
// checks for any OTHER `held-*` marker already there - if one exists, both
// processes believe they hold the lock simultaneously, which is exactly
// the bug this regression test guards against.
async function main(): Promise<void> {
  const lockPath = process.env.WORKER_LOCK_PATH;
  const markerDir = process.env.WORKER_MARKER_DIR;
  const label = process.env.WORKER_LABEL;
  // Optional: when set, this worker signals `<dir>/held` once it is holding
  // the lock and has written its marker, then blocks until `<dir>/release`
  // appears before releasing - letting a test resume a DIFFERENT, paused
  // contender while this worker's fresh lock is still genuinely on disk
  // and it is still inside its critical section, rather than only after it
  // has fully exited.
  const holdBarrierDir = process.env.WORKER_HOLD_BARRIER_DIR;
  if (
    lockPath === undefined ||
    markerDir === undefined ||
    label === undefined
  ) {
    throw new Error(
      "cli-lock-worker: WORKER_LOCK_PATH, WORKER_MARKER_DIR, and WORKER_LABEL are required",
    );
  }
  const handle = await __acquireCliLockAtPathForTest(lockPath, {
    reason: `worker-${label}`,
    waitMs: 15_000,
    pollIntervalMs: 25,
  });
  try {
    const ownMarker = join(markerDir, `held-${label}.marker`);
    await writeFile(ownMarker, String(process.pid));
    const entries = await readdir(markerDir);
    const otherHeld = entries.filter(
      (name) => name.startsWith("held-") && name !== `held-${label}.marker`,
    );
    if (otherHeld.length > 0) {
      await writeFile(
        join(markerDir, `violation-${label}.marker`),
        JSON.stringify({ label, otherHeld }),
      );
    }
    if (holdBarrierDir !== undefined) {
      await writeFile(join(holdBarrierDir, "held"), "");
      await waitForFile(join(holdBarrierDir, "release"));
    } else {
      // Hold long enough that a concurrent, badly-behaved holder would
      // have time to also write its own marker and be caught above.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await rm(ownMarker, { force: true });
  } finally {
    await handle.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`cli-lock-worker failed: ${String(err)}\n`);
    process.exit(1);
  });
