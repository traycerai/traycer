import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { config } from "../config";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import { isPackagedRun } from "../store/well-known-cli";

/**
 * Linux: move a command that is about to stop the host OUT of the host's own
 * cgroup before it runs.
 *
 * The host spawns the CLI for maintenance RPCs, for the reconciler, and for a
 * person's command in a Traycer-hosted terminal. Every one of those children
 * shares the host unit's cgroup, and the unit is `KillMode=control-group`: the
 * `systemctl --user stop` the command itself issues kills the process that
 * issued it, mid-update. The host is down, the updater is gone, and nothing
 * finishes the swap or starts the new bytes.
 *
 * `systemd-run --user --scope` is the fix because a scope EXECS IN PLACE: the
 * re-spawned CLI lands in its own `run-*.scope`, a sibling of the host unit
 * rather than a child, and no wrapper process is left behind inside the host's
 * cgroup. `setsid` does not help - it changes the session, not the cgroup - and
 * relaxing the unit to `KillMode=process` would free every agent the host has
 * spawned, not just this one command.
 *
 * Two lines of defence, in this order:
 *
 *   1. this module's relocation, which moves the process that is going to issue
 *      the stop;
 *   2. `assertNotInsideHostUnit` in the stop-intent wrapper (`service/index.ts`),
 *      which re-reads the cgroup and refuses the stop outright if we are still
 *      inside the unit.
 *
 * The second is what makes every failure mode closed rather than silent: no
 * `systemd-run` on PATH, no user manager, a scope that failed to move us, or a
 * recursion flag set without a real cgroup change all end at the refusal with
 * the host still up. Which is also why the relocation env flag is never taken
 * as evidence that the move happened - only the cgroup is.
 */

/**
 * The commands whose bodies reach a host stop, keyed by Commander command path.
 *
 * Checked once in `withRunner`, the same shape as `READONLY_REFUSED_COMMANDS`,
 * rather than at each stop site: the relocation has to happen BEFORE the
 * command body so the relocated child - not the parent that is about to die -
 * owns the CLI lock, the update contender claim, the dispatch ACK and the
 * progress marker.
 *
 * `host start` is deliberately absent: it IS the unit's main process and never
 * stops anything. So are the `agent *-from-hook` commands, which run inside an
 * agent process and are supposed to die with the host.
 */
export const HOST_STOPPING_COMMANDS: ReadonlySet<string> = new Set([
  "host update",
  "host apply",
  "host install",
  "host ensure",
  "host restart",
  "host stop",
  "host uninstall",
  "host free-port-and-restart",
  "host service uninstall",
]);

/**
 * Recursion flag set on the relocated child.
 *
 * It stops a child from relocating itself again on a machine where the move
 * silently did nothing. It is NOT proof that the move worked, and nothing in
 * this file or in the guard treats it as such.
 */
export const TRAYCER_CLI_RELOCATED_ENV = "TRAYCER_CLI_RELOCATED";

const SYSTEMD_RUN = "systemd-run";

// `--quiet` keeps systemd-run's own "Running as unit" chatter off a stream the
// child needs for NDJSON; `--collect` only garbage-collects the scope once it
// exits. Neither is what makes the child survive - the cgroup separation is.
const SYSTEMD_RUN_SCOPE_ARGS: readonly string[] = [
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "--",
];

const PROC_SELF_CGROUP = "/proc/self/cgroup";

const HOST_UNIT_PREFIX = "ai.traycer.host";
const SYSTEMD_SERVICE_SUFFIX = ".service";

const NOT_NEEDED: CgroupRelocation = { kind: "not-needed" };

/** The host unit this process is running inside, as `/proc/self/cgroup` reports it. */
export interface HostUnitCgroup {
  // The unit as systemd names it, dev slots included
  // (`ai.traycer.host.staging.service`). What the refusal message names, so an
  // operator can act on the machine in front of them.
  readonly unit: string;
  // The full cgroup path the unit was found in, for the error details.
  readonly path: string;
}

export type CgroupRelocation =
  | { readonly kind: "not-needed" }
  | { readonly kind: "completed"; readonly exitCode: number };

/**
 * Relocate, and report whether the command still has to run here.
 *
 * `completed` means the child ran the whole command and this process must exit
 * with its code without running anything itself. `not-needed` means nothing was
 * moved and the caller runs the command in place - which covers every machine
 * where nothing can kill us for issuing a stop: a host started by hand, WSL
 * without systemd, a container, and every non-Linux platform.
 *
 * Throws `SERVICE_CONTROL_FAILED` when the move was needed and could not be
 * made. It deliberately does not fall through to running the command: doing so
 * is what kills the host-spawned updater mid-update.
 */
export async function relocateOutOfHostCgroupIfNeeded(
  commandPath: string,
): Promise<CgroupRelocation> {
  if (osPlatform() !== "linux") return NOT_NEEDED;
  if (!HOST_STOPPING_COMMANDS.has(commandPath)) return NOT_NEEDED;
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
  return {
    kind: "completed",
    exitCode: await runInTransientScope(argv, commandPath, inside),
  };
}

/**
 * The second line: refuse a stop issued from inside the host's own cgroup.
 *
 * Called from the stop-intent wrapper BEFORE the intent is announced, so a
 * refusal leaves no record of a stop that never happened.
 */
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

/**
 * The argv to hand `systemd-run`, built BY RUN KIND rather than by copying
 * `process.argv`.
 *
 * The CLI's own convention is that command tokens start at `process.argv[2]`
 * (`argvRequestsJson`, and the script-entry guard that treats `argv[1]` as the
 * binary or script). The two run kinds put different things in front of that:
 *
 *   - packaged (SEA): `argv[1]` is the binary path the loader puts there, so
 *     copying it would hand Commander `/slot/traycer` as the first command
 *     token and fail the parse before the update ever starts;
 *   - interpreter (tsx/node in a tree run): the loader flags in `execArgv` and
 *     the script path in `argv[1]` are both needed, or the child has no CLI to
 *     run.
 *
 * Every command flag - `--json`, `--ack-nonce`, `--version`, the runner flags -
 * lives in `argv.slice(2)` and travels unchanged either way.
 */
export function relocationArgv(run: RelocationRun): readonly string[] {
  return run.packaged
    ? [run.execPath, ...run.argv.slice(2)]
    : [run.execPath, ...run.execArgv, ...run.argv.slice(1)];
}

/**
 * The host unit named by this process's cgroup, or `null`.
 *
 * Both cgroup layouts are read, and EVERY line that can carry unit placement is
 * checked rather than the first one found: a hybrid machine reports a unified
 * `0::/` line beside the `name=systemd` v1 hierarchy systemd is actually
 * placing units in, and trusting the unified line there would answer "not
 * inside a host unit" for a process that very much is.
 */
export function findHostUnitCgroup(contents: string): HostUnitCgroup | null {
  for (const line of contents.split("\n")) {
    const path = systemdCgroupPath(line);
    if (path === null) continue;
    const unit = hostUnitSegment(path);
    if (unit !== null) return { unit, path };
  }
  return null;
}

async function readHostUnitCgroup(): Promise<HostUnitCgroup | null> {
  let contents: string;
  try {
    contents = await readFile(PROC_SELF_CGROUP, "utf8");
  } catch {
    // No `/proc/self/cgroup` at all means no cgroup that can kill us, which is
    // the same answer as "not inside a host unit".
    return null;
  }
  return findHostUnitCgroup(contents);
}

// `<hierarchy>:<controllers>:<path>`. The unified v2 line is `0::<path>`; on v1
// only the systemd hierarchy carries unit placement (`name=systemd`, or a bare
// `systemd` on kernels that drop the prefix), and the controller hierarchies
// beside it do not.
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

// A path segment naming a host unit - `ai.traycer.host.service` and every dev
// slot (`ai.traycer.host.staging.service`). A relocated child sits in a
// `run-*.scope` segment instead and matches nothing here, which is what makes
// the guard's re-read meaningful.
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

/**
 * Run the command in a transient scope and forward its exit code.
 *
 * The parent WAITS, attached, and installs no signal forwarding. A person in a
 * Traycer-hosted terminal keeps seeing output through the inherited stdio until
 * the stop kills their terminal; a host-spawned parent dies with the cgroup,
 * which is the expected end for it and is why nothing here tries to shepherd
 * the child. Exiting immediately instead would lose that output and hand the
 * host's `exited` promise a false early settle.
 *
 * `systemd-run` exiting non-zero before it execs is indistinguishable from the
 * command's own failure and is forwarded as such; only a failure to spawn it at
 * all (no such binary, no permission) is reported as the relocation failure it
 * is.
 */
async function runInTransientScope(
  argv: readonly string[],
  commandPath: string,
  inside: HostUnitCgroup,
): Promise<number> {
  const logger = createCliLogger(config.environment);
  let child: ChildProcess;
  try {
    child = spawn(SYSTEMD_RUN, [...SYSTEMD_RUN_SCOPE_ARGS, ...argv], {
      // Inherited, not piped: under `--json` the child owns the NDJSON stream
      // and this process writes nothing to it.
      stdio: "inherit",
      env: { ...process.env, [TRAYCER_CLI_RELOCATED_ENV]: "1" },
    });
  } catch (cause) {
    throw relocationFailed(logger, commandPath, inside, cause);
  }
  return await new Promise<number>((resolve, reject) => {
    child.once("spawn", () => {
      logger.info("relocated host-stopping command into a transient scope", {
        command: commandPath,
        unit: inside.unit,
      });
    });
    child.once("error", (cause) => {
      reject(relocationFailed(logger, commandPath, inside, cause));
    });
    // A child killed by a signal reports `null`, which is a failure the caller
    // has to see as one.
    child.once("close", (code) => resolve(code ?? 1));
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
