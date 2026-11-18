import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireUpdateAttemptLock,
  rebindAttemptLockLiveness,
} from "../../lock";

const hostHomeValue = process.env.MAINTENANCE_HOST_HOME;
const barrierDirValue = process.env.MAINTENANCE_BARRIER_DIR;
const scriptPathValue = process.argv[1];
const mode = process.argv[2] ?? "helper";
const POLL_MS = 20;
const MAX_WAIT_MS = 30_000;

if (
  hostHomeValue === undefined ||
  barrierDirValue === undefined ||
  scriptPathValue === undefined
) {
  throw new Error(
    "maintenance rebind primitive fixture requires host home, barrier, and script path",
  );
}

const hostHomeDir: string = hostHomeValue;
const barrierDir: string = barrierDirValue;
const scriptPath: string = scriptPathValue;

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
  throw new Error(
    `maintenance rebind primitive fixture timed out waiting for ${path}`,
  );
}

async function actuator(): Promise<void> {
  let started = false;
  let settled = false;
  const finish = async (): Promise<void> => {
    const released = await stat(join(barrierDir, "actuator-release")).then(
      () => true,
      () => false,
    );
    if (!started || settled || !released) return;
    settled = true;
    await writeFile(join(barrierDir, "actuator-exited"), String(process.pid));
    process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        if (JSON.parse(line)?.kind === "start" && !started) {
          started = true;
          void writeFile(
            join(barrierDir, "actuator-ready"),
            String(process.pid),
          ).then(() =>
            writeFile(
              join(barrierDir, "actuator-edge-running"),
              String(process.pid),
            ),
          );
        }
      } catch {
        // The supervisor owns protocol validation; malformed input is a stop.
        void finish();
      }
    }
  });
  process.stdin.once("end", () => {
    void finish();
  });
  await waitFor(join(barrierDir, "actuator-ready"));
  await waitFor(join(barrierDir, "actuator-release")).then(finish);
}

async function executor(): Promise<void> {
  const actuatorProcess = spawn("bun", ["run", scriptPath, "actuator"], {
    env: {
      ...process.env,
      MAINTENANCE_HOST_HOME: hostHomeDir,
      MAINTENANCE_BARRIER_DIR: barrierDir,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (
    actuatorProcess.pid === undefined ||
    actuatorProcess.stdin === null ||
    actuatorProcess.stdout === null
  ) {
    throw new Error("executor did not establish actuator pipes");
  }
  let buffer = "";
  const bound = new Promise<void>((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          if (JSON.parse(line)?.kind !== "actuator-bound") {
            reject(new Error("executor did not receive actuator binding"));
            return;
          }
          resolve();
        } catch {
          reject(new Error("executor received malformed actuator binding"));
          return;
        }
      }
    });
    process.stdin.once("end", () =>
      reject(new Error("helper closed before actuator binding")),
    );
  });
  process.stdout.write(
    `${JSON.stringify({ kind: "bind-actuator", pid: actuatorProcess.pid })}\n`,
  );
  await bound;
  actuatorProcess.stdin.write(`${JSON.stringify({ kind: "start" })}\n`);
  actuatorProcess.stdout.setEncoding("utf8");
  actuatorProcess.stdout.on("data", (chunk: string) =>
    process.stdout.write(chunk),
  );
  await waitFor(join(barrierDir, "actuator-ready"));
  await writeFile(
    join(barrierDir, "executor-ready"),
    JSON.stringify({
      executorPid: process.pid,
      actuatorPid: actuatorProcess.pid,
    }),
  );
  await new Promise<void>((resolve) =>
    actuatorProcess.once("exit", () => resolve()),
  );
}

async function helper(): Promise<void> {
  await mkdir(hostHomeDir, { recursive: true });
  const outcome = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason: "maintenance-rebind-liveness-primitive",
    waitMs: 0,
    pollIntervalMs: 10,
  });
  if (outcome.kind !== "acquired")
    throw new Error(`helper failed to acquire: ${outcome.kind}`);

  const executorProcess = spawn(
    "bun",
    ["run", scriptPath, "--root-maintenance-supervisor"],
    {
      env: {
        ...process.env,
        MAINTENANCE_HOST_HOME: hostHomeDir,
        MAINTENANCE_BARRIER_DIR: barrierDir,
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  if (executorProcess.pid === undefined)
    throw new Error("helper did not receive executor pid");
  if (executorProcess.stdin === null || executorProcess.stdout === null) {
    throw new Error("helper did not establish supervisor pipes");
  }
  executorProcess.stdout.setEncoding("utf8");
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    executorProcess.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as {
            readonly kind?: string;
            readonly pid?: number;
          };
          if (message.kind !== "bind-actuator" || message.pid === undefined) {
            reject(new Error("supervisor did not request actuator binding"));
            return;
          }
          void writeFile(
            join(barrierDir, "supervisor-bind"),
            JSON.stringify(message),
          );
          // Exercise only the low-level rebind primitive: publish the
          // actuator identity before granting the executor permission to
          // start it. Production's C-envelope topology is tested separately.
          void rebindAttemptLockLiveness(outcome.handle, message.pid, {})
            .then(() => {
              executorProcess.stdin.write(
                `${JSON.stringify({ kind: "actuator-bound" })}\n`,
              );
              void writeFile(
                join(barrierDir, "supervisor-granted"),
                JSON.stringify({ kind: "actuator-bound" }),
              );
              void writeFile(
                join(barrierDir, "helper-rebound"),
                JSON.stringify({
                  helperPid: process.pid,
                  executorPid: executorProcess.pid,
                  actuatorPid: message.pid,
                }),
              ).then(resolve, reject);
            })
            .catch(reject);
        } catch {
          reject(new Error("supervisor emitted malformed binding"));
        }
      }
    });
    executorProcess.once("exit", (code) => {
      if (code !== 0)
        reject(
          new Error(`supervisor exited before binding (${code ?? "null"})`),
        );
    });
  });
  await waitFor(join(barrierDir, "helper-release"));
}

if (mode === "actuator") await actuator();
else if (mode === "--root-maintenance-supervisor") await executor();
else await helper();
