import { spawn, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { Readable } from "node:stream";
import { config } from "../config";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import {
  CLI_ERROR_CODES,
  cliError,
  isErrnoException,
  type CliError,
} from "../runner/errors";
import { isPackagedRun } from "../store/well-known-cli";

/** Linux: move a stop command out of the host unit cgroup before the stop, or systemd kills the updater with the host. */

/** Whether THIS invocation of an allowlisted command can reach a host stop, given the options Commander parsed for it. Command path alone is too coarse. */
export type HostStopReachable = (options: Record<string, unknown>) => boolean;

const ALWAYS_STOPS: HostStopReachable = () => true;

/** Commands whose bodies reach a host stop. Keep in lockstep with the Commander paths that call stop. */
export const HOST_STOPPING_COMMANDS: ReadonlyMap<string, HostStopReachable> =
  new Map<string, HostStopReachable>([
    ["host update", ALWAYS_STOPS],
    ["host restart", ALWAYS_STOPS],
    ["host stop", ALWAYS_STOPS],
    ["host free-port-and-restart", ALWAYS_STOPS],
    ["host service uninstall", ALWAYS_STOPS],
    // Stops only in its rollback (`systemctl --user disable --now` on the live unit when `enable --now` fails, `service/platforms/linux.ts`), but that rollback is reachable from any failure of the enable, so it relocates unconditionally: a CLI that dies with the unit it is rolling back never removes the manifest or reports the install's own error.
    // Its second line is the guard on the install actuator in `service/index.ts`, ahead of the registration transaction.
    ["host service install", ALWAYS_STOPS],
    ["host install", (options) => options.serviceRegister !== false],
    ["host ensure", (options) => options.serviceRegister !== false],
    ["host apply", (options) => options.service !== false],
    ["host uninstall", (options) => options.all === true],
  ]);

/** Recursion flag set on the relocated child. It stops a child from relocating itself again on a machine where the move silently did nothing. */
export const TRAYCER_CLI_RELOCATED_ENV = "TRAYCER_CLI_RELOCATED";

const SYSTEMD_RUN = "systemd-run";

// `--quiet` keeps systemd-run's own "Running as unit" chatter off a stream the child needs for NDJSON; `--collect` only garbage-collects the scope once it exits.
// Neither is what makes the child survive - the cgroup separation is.
const SYSTEMD_RUN_SCOPE_ARGS: readonly string[] = [
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "--",
];

// The ack channel: fd 3 on the relocated child, `stdio[3]` on the parent. One
// byte, whose only meaning is "a CLI reached `withRunner` in the new scope".
const RELOCATION_ACK_FD = 3;
const RELOCATION_ACK_BYTE = "\n";

const PROC_SELF_CGROUP = "/proc/self/cgroup";

const HOST_UNIT_PREFIX = "ai.traycer.host";
const SYSTEMD_SERVICE_SUFFIX = ".service";

const NOT_NEEDED: CgroupRelocation = { kind: "not-needed" };

/** The host unit this process is running inside, as `/proc/self/cgroup` reports it. */
export interface HostUnitCgroup {
  // The unit as systemd names it, dev slots included (`ai.traycer.host.staging.service`).
  // What the refusal message names, so an operator can act on the machine in front of them.
  readonly unit: string;
  // The full cgroup path the unit was found in, for the error details.
  readonly path: string;
}

export type CgroupRelocation =
  | { readonly kind: "not-needed" }
  | { readonly kind: "completed"; readonly exitCode: number };

/** Relocate, and report whether the command still has to run here. `completed` means the child ran the whole command and this process must exit with its code without running anything itself. */
export async function relocateOutOfHostCgroupIfNeeded(
  commandPath: string,
  options: Record<string, unknown>,
): Promise<CgroupRelocation> {
  if (osPlatform() !== "linux") return NOT_NEEDED;
  const reachesStop = HOST_STOPPING_COMMANDS.get(commandPath);
  if (reachesStop === undefined || !reachesStop(options)) return NOT_NEEDED;
  if ((process.env[TRAYCER_CLI_RELOCATED_ENV] ?? "").length > 0) {
    return NOT_NEEDED;
  }
  const inside = await readHostUnitCgroup();
  if (inside === null) return NOT_NEEDED;
  const argv = relocationArgv({
    packaged: await isPackagedRun(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
  });
  assertArgvSurvivesSystemdRun(argv, commandPath, inside);
  return {
    kind: "completed",
    exitCode: await runInTransientScope(argv, commandPath, inside),
  };
}

/** Refuse to relocate an argv `systemd-run` may rewrite. */
function assertArgvSurvivesSystemdRun(
  argv: readonly string[],
  commandPath: string,
  inside: HostUnitCgroup,
): void {
  const expandable = argv.find((token) => token.includes("$"));
  if (expandable === undefined) return;
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      `refusing to relocate '${commandPath}' out of the ${inside.unit} cgroup: ` +
      "an argument contains '$', which systemd-run can rewrite; " +
      "run this from a shell outside the Traycer host.",
    details: {
      command: commandPath,
      argument: expandable,
      cgroup: inside.path,
      unit: inside.unit,
    },
    exitCode: 1,
  });
}

/** The second line: refuse a stop issued from inside the host's own cgroup. Called from the stop-intent wrapper BEFORE the intent is announced, so a refusal leaves no record of a stop that never happened. */
export async function assertNotInsideHostUnit(): Promise<void> {
  if (osPlatform() !== "linux") return;
  const inside = await readHostUnitCgroup();
  if (inside === null) return;
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      `refusing to stop ${inside.unit} from inside its own cgroup; ` +
      "run this from a shell outside the Traycer host, or update the Traycer CLI",
    details: { cgroup: inside.path, unit: inside.unit },
    exitCode: 1,
  });
}

/** How this process was launched, as `relocationArgv` needs to see it. */
export interface RelocationRun {
  readonly packaged: boolean;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
}

/** The argv to hand `systemd-run`, built BY RUN KIND rather than by copying `process.argv`. The CLI's own convention is that command tokens start at `process.argv[2]` (`argvRequestsJson`, and the script-entry guard that treats `argv[1]` as the binary or script). */
export function relocationArgv(run: RelocationRun): readonly string[] {
  return run.packaged
    ? [run.execPath, ...run.argv.slice(2)]
    : [run.execPath, ...run.execArgv, ...run.argv.slice(1)];
}

/** The host unit named by this process's cgroup, or `null`. Both cgroup layouts are read, and EVERY line that can carry unit placement is checked rather than the first one found: a hybrid machine reports a unified `0::/` line beside the `name=systemd` v1 hierarchy systemd is actually placing units in, and trusting the unified line there would answer "not inside a host unit" for a process that very much is. */
export function findHostUnitCgroup(contents: string): HostUnitCgroup | null {
  for (const line of contents.split("\n")) {
    const path = systemdCgroupPath(line);
    if (path === null) continue;
    const unit = hostUnitSegment(path);
    if (unit !== null) return { unit, path };
  }
  return null;
}

/** Read our own cgroup membership, or refuse. Do not guess. */
async function readHostUnitCgroup(): Promise<HostUnitCgroup | null> {
  let contents: string;
  try {
    contents = await readFile(PROC_SELF_CGROUP, "utf8");
  } catch (cause) {
    const absent = isAbsentPath(cause);
    createCliLogger(config.environment).debug(
      "Failed to read the cgroup this process belongs to",
      {
        path: PROC_SELF_CGROUP,
        absent,
        cause: errorFromUnknown(cause).message,
      },
    );
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message:
        (absent
          ? `${PROC_SELF_CGROUP} is absent in this environment`
          : `could not read ${PROC_SELF_CGROUP}`) +
        ", so this command cannot tell whether stopping the Traycer host " +
        "would also kill it. Run it again from a shell outside the Traycer host.",
      details: { path: PROC_SELF_CGROUP, absent },
      exitCode: 1,
    });
  }
  return findHostUnitCgroup(contents);
}

function isAbsentPath(cause: unknown): boolean {
  if (!isErrnoException(cause)) return false;
  return cause.code === "ENOENT" || cause.code === "ENOTDIR";
}

// `<hierarchy>:<controllers>:<path>`.
// The unified v2 line is `0::<path>`; on v1 only the systemd hierarchy carries unit placement (`name=systemd`, or a bare `systemd` on kernels that drop the prefix), and the controller hierarchies beside it do not.
function systemdCgroupPath(line: string): string | null {
  const firstColon = line.indexOf(":");
  if (firstColon < 0) return null;
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;
  const hierarchy = line.slice(0, firstColon);
  const controllers = line.slice(firstColon + 1, secondColon);
  const path = line.slice(secondColon + 1).trim();
  if (path.length === 0) return null;
  if (hierarchy === "0" && controllers.length === 0) return path;
  return controllers === "name=systemd" || controllers === "systemd"
    ? path
    : null;
}

// A path segment naming a host unit - `ai.traycer.host.service` and every dev slot (`ai.traycer.host.staging.service`).
// A relocated child sits in a `run-*.scope` segment instead and matches nothing here, which is what makes the guard's re-read meaningful.
function hostUnitSegment(path: string): string | null {
  for (const segment of path.split("/")) {
    if (
      segment.startsWith(HOST_UNIT_PREFIX) &&
      segment.endsWith(SYSTEMD_SERVICE_SUFFIX)
    ) {
      return segment;
    }
  }
  return null;
}

/** Run in a transient scope and forward the exit code. Do not relay SIGTERM. */
async function runInTransientScope(
  argv: readonly string[],
  commandPath: string,
  inside: HostUnitCgroup,
): Promise<number> {
  const logger = createCliLogger(config.environment);
  let child: ChildProcess;
  try {
    child = spawn(SYSTEMD_RUN, [...SYSTEMD_RUN_SCOPE_ARGS, ...argv], {
      // stdio 0-2 inherited, not piped: under `--json` the child owns the NDJSON stream and this process writes nothing to it. fd 3 is the ack channel and carries one byte in the other direction.
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      // The scope moves the child's CGROUP; it does not move its SESSION.
      // In a Traycer-hosted terminal the child would still be in the session whose PTY the host owns, so the moment the stop closes that master the kernel SIGHUPs the terminal's foreground group and takes the relocated updater with it - the cgroup escape wasted.
      detached: true,
      env: { ...process.env, [TRAYCER_CLI_RELOCATED_ENV]: "1" },
    });
  } catch (cause) {
    throw relocationFailed(logger, commandPath, inside, cause);
  }
  logger.debug("Spawned systemd-run for a host-stopping command", {
    command: commandPath,
    unit: inside.unit,
  });
  const stopRelay = relayInterruptSignal(child);
  try {
    return await waitForRelocatedExit(child, logger, commandPath, inside);
  } finally {
    stopRelay();
  }
}

/** Forward only Ctrl-C to the relocated child's process group. Do not relay SIGTERM or SIGHUP. */
function relayInterruptSignal(child: ChildProcess): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => undefined;
  const onInterrupt = (): void => {
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      // Already gone, or never became a group leader. Neither is actionable:
      // the exit we are waiting on is what reports the outcome.
    }
  };
  process.on("SIGINT", onInterrupt);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
  };
}

async function waitForRelocatedExit(
  child: ChildProcess,
  logger: ILogger,
  commandPath: string,
  inside: HostUnitCgroup,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    // TWO INDEPENDENT FACTS, and neither implies the other: - the process ENDED, and with what code (`exit`); - the ack channel is DONE, so no byte can still arrive (`end`).
    // The obvious spelling - decide on `close`, which Node fires only once the stdio streams are finished - is wrong on the runtime half of this workspace.
    let acknowledged = false;
    let exited = false;
    let exitCode: number | null = null;
    let ackFinished = false;
    const settle = (): void => {
      if (!exited) return;
      // An ack already in hand answers the question; waiting for the stream to
      // end as well would only add a way to hang.
      if (acknowledged) {
        // A child killed by a signal reports `null`, which is a failure the
        // caller has to see as one.
        resolve(exitCode ?? 1);
        return;
      }
      // No ack YET. Only an ended channel makes that final: until then a byte
      // may still be in flight behind the process's own exit.
      if (!ackFinished) return;
      reject(relocationNeverStarted(logger, commandPath, inside, exitCode));
    };
    const ack = child.stdio[RELOCATION_ACK_FD];
    if (ack instanceof Readable) {
      ack.on("data", () => {
        if (acknowledged) return;
        acknowledged = true;
        logger.info("relocated host-stopping command into a transient scope", {
          command: commandPath,
          unit: inside.unit,
        });
        settle();
      });
      // `end` is the ordinary finish; `close` covers a stream destroyed without ending, and `error` a channel that broke.
      // Any of the three means no further byte is coming, which is all this flag claims.
      const finishAck = (): void => {
        if (ackFinished) return;
        ackFinished = true;
        settle();
      };
      ack.once("end", finishAck);
      ack.once("close", finishAck);
      ack.once("error", finishAck);
    } else {
      // No readable channel at all.
      // Both supported runtimes hand back a `net.Socket` here, so this is a runtime that cannot answer the question.
      ackFinished = true;
    }
    child.once("error", (cause) => {
      reject(relocationFailed(logger, commandPath, inside, cause));
    });
    // `exit`, not `close`: this listener is about the process ending, and nothing else.
    // Whether the ack channel has drained is the other half, tracked above.
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      settle();
    });
  });
}

/** The relocated CLI's entry duties: say hello on fd 3, and stop depending on a terminal that is about to be closed underneath it. Both belong at entry and both are no-ops on an ordinary run, which is why they share the gate. */
export function acknowledgeRelocationEntry(): void {
  if ((process.env[TRAYCER_CLI_RELOCATED_ENV] ?? "").length === 0) return;
  try {
    writeSync(RELOCATION_ACK_FD, RELOCATION_ACK_BYTE);
  } catch {
    // Nothing is listening, or the write failed. Neither changes what this
    // process was asked to do.
  }
  // The other half of surviving the stop.
  // This process kept the terminal's fds 0-2 but left its session, so when the stop closes the PTY master the writes start failing with EIO instead of the process being SIGHUPed.
  const ignore = (): void => undefined;
  process.stdout.on("error", ignore);
  process.stderr.on("error", ignore);
}

function relocationNeverStarted(
  logger: ILogger,
  commandPath: string,
  inside: HostUnitCgroup,
  exitCode: number | null,
): CliError {
  logger.debug("systemd-run exited before the relocated command started", {
    command: commandPath,
    unit: inside.unit,
    exitCode,
  });
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      `could not move '${commandPath}' out of the ${inside.unit} cgroup: ` +
      "systemd-run exited before the command started, so there is no user " +
      "manager or the transient scope was refused. " +
      "Run it again from a shell outside the Traycer host.",
    details: {
      command: commandPath,
      cgroup: inside.path,
      unit: inside.unit,
      systemdRunExitCode: exitCode,
    },
    exitCode: 1,
  });
}

function relocationFailed(
  logger: ILogger,
  commandPath: string,
  inside: HostUnitCgroup,
  cause: unknown,
): CliError {
  // The cause is a spawn errno, useful for diagnosis and nothing else; the
  // message the operator acts on is the same whichever errno it was.
  logger.debug("Failed to relocate a host-stopping command", {
    command: commandPath,
    unit: inside.unit,
    cause: errorFromUnknown(cause).message,
  });
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      `could not move '${commandPath}' out of the ${inside.unit} cgroup with ${SYSTEMD_RUN}, ` +
      "and running it here would stop this process along with the host. " +
      "Run it again from a shell outside the Traycer host.",
    details: { command: commandPath, cgroup: inside.path, unit: inside.unit },
    exitCode: 1,
  });
}
