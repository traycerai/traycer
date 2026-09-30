import { spawn } from "node:child_process";
import { rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const barrierDir = process.env.MAINTENANCE_BARRIER_DIR;
const scriptPath = process.argv[1];
const mode = process.argv[2];
const termResistant = process.env.MAINTENANCE_TERM_RESISTANT === "1";
const TERM_GRACE_MS = 2_100;
if (
  barrierDir === undefined ||
  scriptPath === undefined ||
  mode === undefined
) {
  throw new Error("node actuator fixture requires barrier and mode");
}

// A stat-based `waitForFile` in the test (and in this fixture) only proves
// the barrier file EXISTS - `writeFile` truncates-then-writes, so a reader
// can observe the path between those two steps and read back an empty or
// partial body. Writing to a same-directory temp path and `rename`-ing it
// into place makes every stat-visible barrier file a complete one; `rename`
// is atomic within a single filesystem, which every barrier directory here
// is (always created under the same host home / temp root as the file it
// receives).
async function writeBarrier(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, path);
}

async function waitFor(path) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`node actuator fixture timed out waiting for ${path}`);
}

async function descendant() {
  // `on`, never `once`, in both modes. C signals E twice - through D's group
  // and then directly - and on a loaded machine C can be descheduled between
  // the two kill() calls long enough for E to run the first handler. A
  // `once` listener removes itself, Node then closes its signal handle and
  // SIGTERM reverts to the default action, so the second TERM kills E before
  // the async barrier write below has created its file. A listener that
  // stays installed makes every later TERM a no-op: only SIGKILL can end a
  // TERM-resistant E, and the graceful path runs exactly once.
  let termHandled = false;
  process.on("SIGTERM", () => {
    if (termHandled) return;
    termHandled = true;
    if (!termResistant) {
      void writeBarrier(
        join(barrierDir, "descendant-exited"),
        String(process.pid),
      ).then(() => process.exit(0));
      return;
    }
    // The supervisor must escalate a real, TERM-resistant descendant to
    // SIGKILL and still keep the C envelope published until the reap. There
    // is deliberately no release-barrier exit path in this mode.
    void writeBarrier(
      join(barrierDir, "descendant-term-received"),
      String(Date.now()),
    );
  });
  await writeBarrier(join(barrierDir, "descendant-ready"), String(process.pid));
  if (termResistant) {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
    return;
  }
  await waitFor(join(barrierDir, "descendant-release"));
  await writeBarrier(
    join(barrierDir, "descendant-exited"),
    String(process.pid),
  );
}

async function actuator() {
  // D is the detached process-group leader. E is deliberately attached to D
  // so the supervisor's negative-PID probe and group teardown cover both.
  const descendantProcess = spawn(
    process.execPath,
    [scriptPath, "descendant"],
    {
      env: { ...process.env, MAINTENANCE_BARRIER_DIR: barrierDir },
      stdio: "ignore",
    },
  );
  if (descendantProcess.pid === undefined) {
    throw new Error("node actuator did not receive descendant pid");
  }
  descendantProcess.unref();
  process.stdout.write(
    `${JSON.stringify({ kind: "bind-actuator", pid: descendantProcess.pid })}\n`,
  );
  await waitFor(join(barrierDir, "descendant-ready"));
  if (termResistant) {
    await new Promise(() => undefined);
  }
  await waitFor(join(barrierDir, "descendant-release"));
  await waitFor(join(barrierDir, "descendant-exited"));
}

async function supervisor() {
  const wrapper = spawn(process.execPath, [scriptPath, "actuator"], {
    env: { ...process.env, MAINTENANCE_BARRIER_DIR: barrierDir },
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (wrapper.stdout === null || wrapper.pid === undefined) {
    throw new Error("node supervisor did not establish wrapper pipe");
  }
  wrapper.stdout.setEncoding("utf8");
  let buffer = "";
  let descendantPid;
  let shuttingDown = false;
  const reapGroup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      process.kill(-wrapper.pid, "SIGTERM");
    } catch {
      // D may have already exited; the direct child probe below is best effort.
    }
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGTERM");
      } catch {
        // E may already have exited with D's group.
      }
    }
    if (termResistant) {
      await waitFor(join(barrierDir, "descendant-term-received"));
      await writeBarrier(
        join(barrierDir, "term-grace-started"),
        String(Date.now()),
      );
      await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
      try {
        process.kill(-wrapper.pid, "SIGKILL");
      } catch {
        // The group may have exited between the grace probe and escalation.
      }
      const groupGoneDeadline = Date.now() + 10_000;
      while (Date.now() < groupGoneDeadline) {
        try {
          process.kill(-wrapper.pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Boolean liveness probe rather than throw-inside-try with a
      // self-filtering catch (which matched its OWN thrown error back out by
      // message string - fragile, and easy to accidentally swallow a
      // genuinely different failure that happens to share wording).
      let groupStillLive = false;
      try {
        process.kill(-wrapper.pid, 0);
        groupStillLive = true;
      } catch {
        // ESRCH (or equivalent) means the group is gone - the success path.
      }
      if (groupStillLive) {
        throw new Error(
          "TERM-resistant process group remained live after SIGKILL",
        );
      }
      await writeBarrier(
        join(barrierDir, "descendant-killed"),
        String(Date.now()),
      );
      await writeBarrier(join(barrierDir, "group-absent"), String(Date.now()));
      await writeBarrier(
        join(barrierDir, "descendant-exited"),
        JSON.stringify({ kind: "sigkill", at: Date.now() }),
      );
      await writeBarrier(
        join(barrierDir, "supervisor-exited"),
        String(process.pid),
      );
      process.exit(0);
      return;
    }
    // If D died before C received SIGTERM, its group leader no longer exists
    // for a reliable negative-PID signal on every POSIX runtime. The release
    // barrier gives E's signal-safe fixture path a deterministic final exit;
    // C still waits for that exit before publishing supervisor-exited.
    await writeBarrier(join(barrierDir, "descendant-release"), "");
    await waitFor(join(barrierDir, "descendant-exited"));
    if (wrapper.exitCode === null) {
      try {
        wrapper.kill("SIGKILL");
      } catch {
        // The direct child may have exited between the probe and kill.
      }
    }
    await writeBarrier(
      join(barrierDir, "supervisor-exited"),
      String(process.pid),
    );
    process.exit(0);
  };
  process.once("SIGTERM", () => void reapGroup());
  await new Promise((resolve, reject) => {
    wrapper.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      void (async () => {
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          if (message.kind !== "bind-actuator" || message.pid === undefined) {
            reject(new Error("node supervisor received malformed binding"));
            return;
          }
          descendantPid = message.pid;
          // Awaited BEFORE the stdout publish below: the consumer waits for
          // the "bind-actuator" stdout line and then immediately reads this
          // file. Publishing first raced the write - the reader could
          // observe the stdout line before the file existed.
          await writeBarrier(
            join(barrierDir, "wrapper-bind"),
            JSON.stringify({ wrapperPid: wrapper.pid, descendantPid }),
          );
          process.stdout.write(
            `${JSON.stringify({
              kind: "bind-actuator",
              pid: process.pid,
              supervisedProcessGroupId: wrapper.pid,
              retainOnPublisherDeath: true,
            })}\n`,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
    wrapper.once("exit", (code) => {
      if (code !== 0)
        reject(
          new Error(`node wrapper exited before binding (${code ?? "null"})`),
        );
    });
  });
  await waitFor(join(barrierDir, "supervisor-release"));
}

if (mode === "descendant") await descendant();
else if (mode === "actuator") await actuator();
else if (mode === "supervisor") await supervisor();
else throw new Error(`unknown node actuator mode: ${mode}`);
