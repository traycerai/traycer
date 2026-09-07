import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
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

// The command cannot enter its critical section until this worker releases the lock, proving the actual CLI command (not Desktop's wrapper) participates in the shared lock.
// This is fixup C1: the desktop side must re-read state after it acquires the lock and detect the terminal supersession that landed mid-wait, not act on whatever it observed before.
async function main(): Promise<void> {
  const lockPath = process.env.WORKER_LOCK_PATH;
  const barrierDir = process.env.WORKER_BARRIER_DIR;
  const cliEntry = process.env.WORKER_CLI_ENTRY;
  const environment = process.env.WORKER_ENVIRONMENT;
  const devDesktopSlot = process.env.WORKER_DEV_DESKTOP_SLOT;
  const cliLockAcquiredMarker = process.env.WORKER_CLI_LOCK_ACQUIRED_MARKER;
  if (
    lockPath === undefined ||
    barrierDir === undefined ||
    cliEntry === undefined ||
    environment === undefined ||
    devDesktopSlot === undefined ||
    cliLockAcquiredMarker === undefined
  ) {
    throw new Error(
      "desktop-cli-lock-worker: lock path, barrier, CLI entry, environment, dev slot, and lock marker are required",
    );
  }
  if (
    environment !== "dev" ||
    process.env.DEV_DESKTOP_SLOT !== devDesktopSlot
  ) {
    throw new Error(
      "desktop-cli-lock-worker: terminal CLI environment/slot diverges from the controller",
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
  const cli = spawn("bun", ["run", cliEntry, "host", "uninstall", "--json"], {
    env: {
      ...process.env,
      DEV_DESKTOP_SLOT: devDesktopSlot,
      TRAYCER_CLI_LOCK_ACQUIRED_MARKER: cliLockAcquiredMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cliStdout = "";
  cli.stdout.on("data", (chunk: Buffer) => {
    cliStdout += chunk.toString();
  });
  let cliStderr = "";
  cli.stderr.on("data", (chunk: Buffer) => {
    cliStderr += chunk.toString();
  });
  const cliExit = new Promise<number | null>((resolve) => {
    cli.once("exit", (code) => resolve(code));
  });
  await outcome.handle.release();
  const exitCode = await cliExit;
  await writeFile(
    join(barrierDir, "cli-exit"),
    JSON.stringify({ exitCode, stdout: cliStdout, stderr: cliStderr }),
  );
  if (exitCode !== 0) {
    throw new Error("desktop-cli-lock-worker: terminal host uninstall failed");
  }
  await writeFile(join(barrierDir, "mutated"), "");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`desktop-cli-lock-worker failed: ${String(err)}\n`);
    process.exit(1);
  });
