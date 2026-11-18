import { spawn, type ChildProcess } from "node:child_process";

// Real child processes for the suites that exercise a pid read against the
// kernel rather than a seam: the host's liveness gates run the unmocked
// `process.kill(pid, 0)` and read the live process's creation stamp with the
// platform's own probe, so a hardcoded "probably free" pid is a live process
// on the machine that happened to reach it first, and a fabricated live pid
// has no stamp to read.

function spawnIdleChild(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  // A fork that fails under memory pressure (EAGAIN) emits `error`, which is
  // an uncaught exception with no listener on it - on top of whatever the
  // caller already reports about the missing pid.
  child.once("error", () => undefined);
  return child;
}

function childPid(child: ChildProcess): number {
  const { pid } = child;
  if (pid === undefined) throw new Error("spawning a child yielded no pid");
  return pid;
}

/**
 * A pid that names no process: a child spawned and waited out, so the kernel
 * has reaped it before anything reads a record naming it. `process.kill(pid,
 * 0)` answers ESRCH for it, and no kernel hands a just-freed pid back before
 * the pid space wraps.
 */
export async function exitedChildPid(): Promise<number> {
  const child = spawnIdleChild("");
  const pid = childPid(child);
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return pid;
}

/**
 * A live process that is NOT this one, with its pid - so an identity read
 * takes the cross-process path production takes (`observeProcessStartAsync`),
 * not the own-pid arm. `stop` must run in cleanup.
 */
export function liveChild(): {
  readonly pid: number;
  readonly stop: () => void;
} {
  const child = spawnIdleChild("setInterval(() => {}, 1000);");
  return {
    pid: childPid(child),
    stop: () => {
      child.kill("SIGKILL");
    },
  };
}
