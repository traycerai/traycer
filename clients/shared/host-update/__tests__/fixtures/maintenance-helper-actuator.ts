import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireUpdateAttemptLock,
  rebindAttemptLockLiveness,
} from "../../lock";

const hostHomeValue = process.env.MAINTENANCE_HOST_HOME;
const barrierDirValue = process.env.MAINTENANCE_BARRIER_DIR;
const fixturePath = process.argv[1];
const mode = process.argv[2] ?? "helper";
const POLL_MS = 20;
const MAX_WAIT_MS = 20_000;

if (
  hostHomeValue === undefined ||
  barrierDirValue === undefined ||
  fixturePath === undefined
) {
  throw new Error(
    "maintenance fixture requires host home, barrier dir, and fixture path",
  );
}
const hostHomeDir: string = hostHomeValue;
const barrierDir: string = barrierDirValue;
const scriptPath: string = fixturePath;

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`maintenance fixture timed out waiting for ${path}`);
}

async function actuator(): Promise<void> {
  await writeFile(join(barrierDir, "actuator-ready"), String(process.pid));
  await waitFor(join(barrierDir, "actuator-release"));
  await writeFile(join(barrierDir, "actuator-exited"), String(process.pid));
}

async function helper(): Promise<void> {
  const outcome = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason: "maintenance-helper-actuator",
    waitMs: 0,
    pollIntervalMs: 10,
  });
  if (outcome.kind !== "acquired") {
    throw new Error(`helper failed to acquire: ${outcome.kind}`);
  }

  const actuatorProcess = spawn("bun", ["run", scriptPath, "actuator"], {
    env: {
      ...process.env,
      MAINTENANCE_HOST_HOME: hostHomeDir,
      MAINTENANCE_BARRIER_DIR: barrierDir,
    },
    stdio: "ignore",
  });
  if (actuatorProcess.pid === undefined) {
    throw new Error("helper actuator did not receive a pid");
  }
  await waitFor(join(barrierDir, "actuator-ready"));
  await rebindAttemptLockLiveness(outcome.handle, actuatorProcess.pid, {});
  await writeFile(
    join(barrierDir, "helper-rebound"),
    JSON.stringify({
      helperPid: process.pid,
      actuatorPid: actuatorProcess.pid,
    }),
  );

  // Deliberately skip handle.release(): the helper's death is the race under
  // test. The supervised actuator remains the authoritative lock publisher.
  process.exit(0);
}

if (mode === "actuator") {
  await actuator();
} else {
  await helper();
}
