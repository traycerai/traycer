import { spawn } from "node:child_process";
import { rename, stat, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
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

// Publishes a barrier file the test reads back by CONTENT, not just
// existence. `writeFile` truncates-then-streams: a reader that stats the
// path between those two steps can observe an empty file. Writing to a temp
// name in the same directory and renaming over the real name makes the
// publish atomic from the reader's side - it only ever observes the file
// absent or fully written.
async function publish(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// Synchronous counterpart for the SIGTERM handler below, which must publish
// before returning to the event loop rather than leaving a write in flight
// across a signal-delivery boundary.
function publishSync(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

async function descendant() {
  if (!termResistant) {
    process.once("SIGTERM", () => {
      void publish(
        join(barrierDir, "descendant-exited"),
        String(process.pid),
      ).then(() => process.exit(0));
    });
  } else {
    // The supervisor must escalate a real, TERM-resistant descendant to
    // SIGKILL and still keep the C envelope published until the reap. There
    // is deliberately no release-barrier exit path in this mode.
    //
    // `once` is wrong here: after it fires, Node removes the listener, and
    // with no SIGTERM listener left libuv restores SIG_DFL. The supervisor's
    // reap sends two SIGTERMs in quick succession - one to the group, one
    // directly to this pid - and a second TERM landing after the reset killed
    // the process the test calls "TERM-resistant", before the async barrier
    // write had run (the test then timed out waiting for the barrier) or
    // after it (the test passed with the descendant already dead). `on` keeps
    // a listener registered for every SIGTERM that follows, so the default
    // disposition is never restored. The publish is synchronous and atomic:
    // the barrier is complete before this handler returns, so its appearance
    // means the handler ran to the end, not that a write was merely queued.
    let termReceived = false;
    process.on("SIGTERM", () => {
      if (termReceived) return;
      termReceived = true;
      publishSync(
        join(barrierDir, "descendant-term-received"),
        String(Date.now()),
      );
    });
  }
  await publish(join(barrierDir, "descendant-ready"), String(process.pid));
  if (termResistant) {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
    return;
  }
  await waitFor(join(barrierDir, "descendant-release"));
  await publish(join(barrierDir, "descendant-exited"), String(process.pid));
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
      await publish(join(barrierDir, "term-grace-started"), String(Date.now()));
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
      await publish(join(barrierDir, "descendant-killed"), String(Date.now()));
      await publish(join(barrierDir, "group-absent"), String(Date.now()));
      await publish(
        join(barrierDir, "descendant-exited"),
        JSON.stringify({ kind: "sigkill", at: Date.now() }),
      );
      await publish(join(barrierDir, "supervisor-exited"), String(process.pid));
      process.exit(0);
      return;
    }
    // If D died before C received SIGTERM, its group leader no longer exists
    // for a reliable negative-PID signal on every POSIX runtime. The release
    // barrier gives E's signal-safe fixture path a deterministic final exit;
    // C still waits for that exit before publishing supervisor-exited.
    await writeFile(join(barrierDir, "descendant-release"), "");
    await waitFor(join(barrierDir, "descendant-exited"));
    if (wrapper.exitCode === null) {
      try {
        wrapper.kill("SIGKILL");
      } catch {
        // The direct child may have exited between the probe and kill.
      }
    }
    await publish(join(barrierDir, "supervisor-exited"), String(process.pid));
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
          await publish(
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
