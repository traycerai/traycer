import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireDesktopCliLock } from "../../desktop-cli-lock";

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
  throw new Error(`desktop-cli-lock-worker: timed out waiting for ${path}`);
}

// Worker process for `host-controller.test.ts`'s genuine two-process
// desktop-held cli-lock test (Host Update Layer Redesign Tech Plan, "cli-lock"
// rule 3 + the ticket's "Desktop lock sections" verification bullet). Spawned
// as a real, separate OS process (via `bun run`) so the test proves an
// in-process `HostController` mutation genuinely blocks on a lock held by a
// DIFFERENT process, not just an in-process promise. Acquires the same
// `acquireDesktopCliLock` primitive `HostController` itself uses, signals
// `<dir>/held`, then - only once the test tells it to via `<dir>/mutate`, by
// which point the desktop side is already blocked waiting on the lock -
// performs a REAL competing terminal mutation: removes the install record on
// disk, the same disk change a genuine `traycer host uninstall --all`
// commits under this same lock. This is fixup C1: the desktop side must
// re-read state after it acquires the lock and detect this superseding
// change landing mid-wait, not act on whatever it observed before it started
// waiting. Signals `<dir>/mutated` once the deletion has landed, then blocks
// until `<dir>/release` appears before releasing and exiting.
async function main(): Promise<void> {
  const lockPath = process.env.WORKER_LOCK_PATH;
  const barrierDir = process.env.WORKER_BARRIER_DIR;
  const installRecordPath = process.env.WORKER_INSTALL_RECORD_PATH;
  if (
    lockPath === undefined ||
    barrierDir === undefined ||
    installRecordPath === undefined
  ) {
    throw new Error(
      "desktop-cli-lock-worker: WORKER_LOCK_PATH, WORKER_BARRIER_DIR, and WORKER_INSTALL_RECORD_PATH are required",
    );
  }
  const outcome = await acquireDesktopCliLock({
    lockPath,
    reason: "desktop-cli-lock-worker",
    waitMs: 15_000,
    pollIntervalMs: 25,
  });
  if (outcome.kind !== "acquired") {
    throw new Error("desktop-cli-lock-worker: failed to acquire the lock");
  }
  await writeFile(join(barrierDir, "held"), "");
  await waitForFile(join(barrierDir, "mutate"));
  await rm(installRecordPath, { force: true });
  await writeFile(join(barrierDir, "mutated"), "");
  await waitForFile(join(barrierDir, "release"));
  await outcome.handle.release();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`desktop-cli-lock-worker failed: ${String(err)}\n`);
    process.exit(1);
  });
