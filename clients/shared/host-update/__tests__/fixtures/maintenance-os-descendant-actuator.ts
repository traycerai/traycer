import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireUpdateAttemptLock,
  rebindAttemptLockLiveness,
} from "../../lock";

const hostHomeDirValue = process.env.MAINTENANCE_HOST_HOME;
const barrierDirValue = process.env.MAINTENANCE_BARRIER_DIR;
const runtime = process.env.MAINTENANCE_RUNTIME ?? process.execPath;
const nodeRuntime = process.env.MAINTENANCE_NODE_BINARY ?? process.execPath;
const scriptPath = process.argv[1];
const mode = process.argv[2] ?? "helper";
const POLL_MS = 20;
const MAX_WAIT_MS = 30_000;

if (
  hostHomeDirValue === undefined ||
  barrierDirValue === undefined ||
  scriptPath === undefined
) {
  throw new Error(
    "OS-descendant fixture requires host home, barrier, and script path",
  );
}
const hostHomeDir: string = hostHomeDirValue;
const barrierDir: string = barrierDirValue;
const script: string = scriptPath;

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
  throw new Error(`OS-descendant fixture timed out waiting for ${path}`);
}

async function waitForProcessGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

async function descendant(): Promise<void> {
  process.once("SIGTERM", () => {
    void writeFile(
      join(barrierDir, "descendant-exited"),
      String(process.pid),
    ).then(() => process.exit(0));
  });
  await writeFile(join(barrierDir, "descendant-ready"), String(process.pid));
  await waitFor(join(barrierDir, "descendant-release"));
  await writeFile(join(barrierDir, "descendant-exited"), String(process.pid));
}

async function actuatorWrapper(): Promise<void> {
  const descendantProcess = spawn(runtime, [script, "descendant"], {
    env: {
      ...process.env,
      MAINTENANCE_HOST_HOME: hostHomeDir,
      MAINTENANCE_BARRIER_DIR: barrierDir,
    },
    // D is the process-group leader; E inherits its group so C can reap the
    // complete OS descendant tree before its liveness envelope disappears.
    detached: true,
    stdio: "ignore",
  });
  if (descendantProcess.pid === undefined)
    throw new Error("wrapper did not receive descendant pid");
  descendantProcess.unref();
  process.stdout.write(
    `${JSON.stringify({ kind: "bind-actuator", pid: descendantProcess.pid })}\n`,
  );
  await waitFor(join(barrierDir, "descendant-ready"));
  await waitFor(join(barrierDir, "descendant-release"));
  await waitFor(join(barrierDir, "descendant-exited"));
}

async function supervisor(): Promise<void> {
  const wrapper = spawn(
    nodeRuntime,
    [
      join(dirname(script), "maintenance-os-descendant-node-actuator.mjs"),
      "actuator",
    ],
    {
      env: {
        ...process.env,
        MAINTENANCE_HOST_HOME: hostHomeDir,
        MAINTENANCE_BARRIER_DIR: barrierDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (wrapper.stdout === null || wrapper.pid === undefined)
    throw new Error("supervisor did not establish wrapper pipe");
  // Bound once, right after the guard: `wrapper.pid` is a property read that
  // TypeScript cannot narrow across the closure below, which is what forced
  // the `wrapper.pid!` non-null assertion. A local `const` carries the
  // guard's proof instead of re-asserting it at every use site.
  const wrapperPid: number = wrapper.pid;
  wrapper.stderr?.setEncoding("utf8");
  wrapper.stderr?.on("data", (chunk: string) => process.stderr.write(chunk));
  let shuttingDown = false;
  let descendantPid: number | undefined;
  const reapDescendantGroup = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      process.kill(-wrapperPid, "SIGTERM");
    } catch {
      // D may already have died; E is still in the same process group when
      // the wrapper death was the first event, and the group kill is best
      // effort on platforms without negative-PID process groups.
    }
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGTERM");
      } catch {
        // D/E may already have exited as part of the group teardown.
      }
      if (!(await waitForProcessGone(descendantPid))) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The final probe distinguishes an already-dead process.
        }
        await waitForProcessGone(descendantPid);
      }
    }
    // E normally writes this from its signal handler. C records the barrier
    // too so the handoff cannot disappear before the reap is observable.
    await writeFile(
      join(barrierDir, "descendant-exited"),
      String(descendantPid ?? -1),
    );
    await writeFile(join(barrierDir, "supervisor-exited"), String(process.pid));
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void reapDescendantGroup();
  });
  wrapper.stdout.setEncoding("utf8");
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    wrapper.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      void (async () => {
        try {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            readonly kind?: string;
            readonly pid?: number;
          };
          if (message.kind !== "bind-actuator" || message.pid === undefined) {
            reject(new Error("wrapper did not publish descendant actuator"));
            return;
          }
          descendantPid = message.pid;
          // Awaited BEFORE the stdout publish below: `helper` waits for the
          // "bind-actuator" stdout line and then immediately reads this
          // file. Publishing first raced the write - the reader could
          // observe the stdout line before the file existed.
          await writeFile(
            join(barrierDir, "wrapper-bind"),
            JSON.stringify({
              wrapperPid,
              descendantPid: message.pid,
            }),
          );
          // The lock envelope is C, not transient D. C owns the process group
          // and remains the authoritative live publisher until that group is
          // reaped.
          process.stdout.write(
            `${JSON.stringify({
              kind: "bind-actuator",
              pid: process.pid,
              supervisedProcessGroupId: wrapperPid,
              retainOnPublisherDeath: true,
            })}\n`,
          );
          resolve();
        } catch {
          reject(new Error("wrapper emitted malformed binding"));
        }
      })();
    });
    wrapper.once("exit", (code) => {
      if (code !== 0)
        reject(new Error(`wrapper exited before binding (${code ?? "null"})`));
    });
  });
  await waitFor(join(barrierDir, "supervisor-release"));
}

async function helper(): Promise<void> {
  await mkdir(hostHomeDir, { recursive: true });
  const outcome = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason: "maintenance-os-descendant-actuator",
    waitMs: 0,
    pollIntervalMs: 10,
  });
  if (outcome.kind !== "acquired")
    throw new Error(`helper failed to acquire: ${outcome.kind}`);
  const supervisorProcess = spawn(
    nodeRuntime,
    [
      join(dirname(script), "maintenance-os-descendant-node-actuator.mjs"),
      "supervisor",
    ],
    {
      env: {
        ...process.env,
        MAINTENANCE_HOST_HOME: hostHomeDir,
        MAINTENANCE_BARRIER_DIR: barrierDir,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (supervisorProcess.stdout === null || supervisorProcess.pid === undefined)
    throw new Error("helper did not establish supervisor pipe");
  supervisorProcess.stdout.setEncoding("utf8");
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    supervisorProcess.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          readonly kind?: string;
          readonly pid?: number;
          readonly supervisedProcessGroupId?: number;
          readonly retainOnPublisherDeath?: boolean;
        };
        if (message.kind !== "bind-actuator" || message.pid === undefined)
          throw new Error("supervisor did not publish liveness envelope");
        void rebindAttemptLockLiveness(outcome.handle, message.pid, {
          supervisedProcessGroupId: message.supervisedProcessGroupId,
          retainOnPublisherDeath: message.retainOnPublisherDeath,
        })
          .then(async () => {
            // The supervisor now awaits the `wrapper-bind` write before it
            // publishes "bind-actuator" on stdout, but this consumer must
            // still wait for the file itself rather than assume the two
            // events are ordered on this side too - `waitFor` is the same
            // barrier-file-presence primitive used everywhere else in this
            // fixture, not a redundant check.
            await waitFor(join(barrierDir, "wrapper-bind"));
            const binding = JSON.parse(
              await readFile(join(barrierDir, "wrapper-bind"), "utf8"),
            ) as {
              readonly wrapperPid: number;
              readonly descendantPid: number;
            };
            await writeFile(
              join(barrierDir, "helper-rebound"),
              JSON.stringify({
                helperPid: process.pid,
                supervisorPid: message.pid,
                wrapperPid: binding.wrapperPid,
                descendantPid: binding.descendantPid,
              }),
            );
            resolve();
          })
          .catch(reject);
      } catch (cause) {
        reject(cause);
      }
    });
    supervisorProcess.once("exit", (code) => {
      if (code !== 0)
        reject(
          new Error(`supervisor exited before binding (${code ?? "null"})`),
        );
    });
  });
  await waitFor(join(barrierDir, "helper-release"));
}

if (mode === "descendant") await descendant();
else if (mode === "actuator") await actuatorWrapper();
else if (mode === "--root-maintenance-supervisor") await supervisor();
else await helper();
