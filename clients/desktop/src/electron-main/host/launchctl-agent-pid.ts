import { spawn } from "node:child_process";
import { log } from "../app/logger";

/**
 * `launchctl print gui/<uid>/<agent-label>` is the ONLY evidence that
 * authorizes a darwin register-cycle skip or a readiness extension. Bootstrap
 * markers never do: the legacy (`<cli-label>`) and agent (`<cli-label>.agent`)
 * labels exec the same `host start` into the same `host.log`, so a post-baseline
 * *legacy*-label start would forge a marker-only "the agent is alive" check
 * while the agent label is dead. Only the live pid of the loaded job UNDER THE
 * AGENT LABEL proves a viable current-generation spawn.
 *
 * A new-format supervisor-pid marker may *corroborate* by matching the pid this
 * returns, but never substitutes for it.
 */

// launchctl print is a fast launchd RPC (observed <50ms); the ceiling bounds a
// wedged launchd (seen during wake-from-sleep recovery) so the readiness /
// register path is not held hostage by a hung subprocess.
const LAUNCHCTL_PRINT_TIMEOUT_MS = 5_000;

/**
 * The minimal `child_process.spawn` surface {@link runLaunchctlPrint} needs.
 * Pulled out (mirroring `host-login-item`'s `BootoutSpawnFn`) so tests inject a
 * stub without mocking `node:child_process` — vitest's jsdom environment does
 * not reliably intercept `import { spawn } from "node:child_process"`.
 */
export interface LaunchctlPrintChildProcess {
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: "SIGTERM"): boolean;
}
export type LaunchctlPrintSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { stdio: Array<"ignore" | "pipe"> },
) => LaunchctlPrintChildProcess;

/**
 * The live pid of the loaded launchd job under `agentLabel` in the caller's GUI
 * domain, or `null` when the job is not loaded, loaded-but-not-running, off
 * darwin, or on any spawn/timeout failure. Best-effort: a failure reads as "no
 * viable agent spawn", which correctly routes the register-cycle machine toward
 * a cycle rather than a false skip.
 */
export async function readAgentLabelPid(
  agentLabel: string,
): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  if (typeof process.getuid !== "function") return null;
  const target = `gui/${process.getuid()}/${agentLabel}`;
  try {
    const output = await runLaunchctlPrint(target, (command, args, options) =>
      spawn(command, args, options),
    );
    return output === null ? null : parseLaunchctlPid(output);
  } catch (err) {
    log.warn(
      "[launchctl-agent-pid] launchctl print threw — treating the agent label as having no viable spawn",
      { target, err },
    );
    return null;
  }
}

/**
 * Extract the live pid from `launchctl print` output. A running job prints a
 * `pid = <n>` line; a loaded-but-not-running job omits it (or shows
 * `state = not running`). Returns the first positive integer pid, else null.
 */
export function parseLaunchctlPid(output: string): number | null {
  const match = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  if (match === null) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Spawn `launchctl print <target>` and resolve its stdout, or `null` when the
 * job is not loaded (non-zero exit — "Could not find service"), the spawn
 * errors, or the call overruns {@link LAUNCHCTL_PRINT_TIMEOUT_MS}. `spawnFn` is
 * injected for testability; production passes `node:child_process.spawn`.
 * Exported for unit tests; production callers use {@link readAgentLabelPid}.
 */
export function runLaunchctlPrint(
  target: string,
  spawnFn: LaunchctlPrintSpawnFn,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnFn("/bin/launchctl", ["print", target], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log.warn(
        "[launchctl-agent-pid] launchctl print exceeded timeout, killed",
        {
          target,
          timeoutMs: LAUNCHCTL_PRINT_TIMEOUT_MS,
        },
      );
      settle(null);
    }, LAUNCHCTL_PRINT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.once("error", (err) => {
      log.warn("[launchctl-agent-pid] launchctl print errored", {
        target,
        err,
      });
      settle(null);
    });
    child.once("exit", (code) => {
      // Non-zero exit → the job is not loaded ("Could not find service"): no
      // viable spawn. Zero → loaded; the pid (if running) is in stdout.
      settle(code === 0 ? stdout : null);
    });
  });
}
