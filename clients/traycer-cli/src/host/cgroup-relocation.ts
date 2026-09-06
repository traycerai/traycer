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
 * as evidence that the move happened - only the cgroup is. Nor is the child's
 * entry acknowledgement: it proves a CLI started in the new scope, never that
 * the scope is outside the host unit, so the guard re-reads the cgroup either
 * way.
 */

/**
 * Whether THIS invocation of an allowlisted command can reach a host stop,
 * given the options Commander parsed for it.
 *
 * Command path alone is too coarse. Four of the ten have a documented
 * bytes-only or leave-it-running form whose body provably never reaches
 * `withStopIntent` or `killHostProcessTree`, and relocating those buys nothing
 * while exposing them to two refusals they cannot deserve: a `$` in a `--from`
 * path, and a machine where a transient scope cannot be started at all.
 *
 * SAFE BECAUSE IT FAILS CLOSED. A predicate that wrongly says "no stop" does
 * not remove the protection, it removes the FIRST line of it: the command runs
 * in place, and `assertNotInsideHostUnit` - which is unconditional, on all four
 * stop routes and on the install actuator, whose Linux rollback is a stop -
 * refuses before any intent is written. The cost of being wrong here is a
 * refused command, not a killed updater.
 */
export type HostStopReachable = (options: Record<string, unknown>) => boolean;

const ALWAYS_STOPS: HostStopReachable = () => true;

/**
 * The commands whose bodies reach a host stop, keyed by Commander command path.
 *
 * Checked once in `withRunner`, the same shape as `READONLY_REFUSED_COMMANDS`,
 * rather than at each stop site: the relocation has to happen BEFORE the
 * command body so the relocated child - not the parent that is about to die -
 * owns the CLI lock, the update contender claim, the dispatch ACK and the
 * progress marker.
 *
 * `host maintenance-lease` - the one host-stopping route registered outside
 * `withRunner` - is deliberately absent. Its caller, the Desktop
 * install/uninstall script, is in the same cgroup it is: started from a
 * Traycer-hosted terminal, both sit inside the host unit, and the stop the
 * lease performs kills the script mid-maintenance whether or not the lease is
 * moved. Relocating it would also put a waiting wrapper between the script and
 * the lease, so the script's cancellation (a signal to its direct child, and
 * that child's exit as proof) would no longer prove the lease holder is gone.
 * The guard in `withStopIntent` refuses instead, and the refusal reaches the
 * script as a protocol `refused` frame with nothing touched.
 *
 * `host start` is deliberately absent: it IS the unit's main process and never
 * stops anything. So are the `agent *-from-hook` commands, which run inside an
 * agent process and are supposed to die with the host.
 *
 * The four conditional entries, each traced to the branch that decides it.
 * They are Linux answers, which is all this map is ever asked for - the caller
 * has already returned on every other platform, and each of these forms is
 * refused outright on Windows anyway:
 *
 *   - `host install` / `host ensure` with `--no-service-register`
 *     (`serviceRegister === false`) take `createBytesOnlyInstallLifecycle`,
 *     whose `beforeSwap` returns immediately off win32, and
 *     `swapLockRecoveryFor` - the only other kill seam in an install - is null
 *     off win32. For `ensure` the bytes-only path is also the ONLY reachable
 *     one: `provisionHost`'s `!registerService` branch either no-ops or
 *     reinstalls, so its register and start branches cannot be reached.
 *   - `host apply --no-service` (`service === false`) passes `lifecycle: null`
 *     to the commit, so there is no `beforeSwap` on any platform.
 *   - `host uninstall` stops only under `--all`; the default path removes bytes
 *     and deliberately "tears nothing down", leaving a running host serving.
 *
 * Everything else stops unconditionally, `host update` included: whether it
 * finds work to do is a question about STATE, and only options are consulted
 * here.
 */
export const HOST_STOPPING_COMMANDS: ReadonlyMap<string, HostStopReachable> =
  new Map<string, HostStopReachable>([
    ["host update", ALWAYS_STOPS],
    ["host restart", ALWAYS_STOPS],
    ["host stop", ALWAYS_STOPS],
    ["host free-port-and-restart", ALWAYS_STOPS],
    ["host service uninstall", ALWAYS_STOPS],
    // Stops only in its rollback (`systemctl --user disable --now` on the live
    // unit when `enable --now` fails, `service/platforms/linux.ts`), but that
    // rollback is reachable from any failure of the enable, so it relocates
    // unconditionally: a CLI that dies with the unit it is rolling back never
    // removes the manifest or reports the install's own error. Its second
    // line is the guard on the install actuator in `service/index.ts`, ahead
    // of the registration transaction.
    ["host service install", ALWAYS_STOPS],
    ["host install", (options) => options.serviceRegister !== false],
    ["host ensure", (options) => options.serviceRegister !== false],
    ["host apply", (options) => options.service !== false],
    ["host uninstall", (options) => options.all === true],
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
 * moved and the caller runs the command in place: a readable cgroup that places
 * this process outside any host unit (a host started by hand, a shell of the
 * user's own), every non-Linux platform, a command or option form that never
 * reaches a stop, and the relocated child itself.
 *
 * Throws `SERVICE_CONTROL_FAILED` when the move was needed and could not be
 * made - including when membership itself could not be established. It
 * deliberately does not fall through to running the command: doing so is what
 * kills the host-spawned updater mid-update.
 */
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

/**
 * Refuse to relocate an argv `systemd-run` may rewrite.
 *
 * systemd's own boundary, read off upstream rather than assumed:
 *
 * | version | scope behaviour with no option passed                  |
 * | ------- | ------------------------------------------------------ |
 * | 249     | argv goes straight to `execvpe`; no expansion option    |
 * | 254-257 | `--expand-environment` exists, scope expansion still    |
 * |         | defaults OFF for compatibility                          |
 * | 258     | scope expansion defaults ON                             |
 *
 * So `--expand-environment=no` cannot simply be passed: it is rejected outright
 * below 254, which is most of the field. Probing the installed version would
 * mean a second process on every relocation to decide something this CLI never
 * composes - SemVer versions, UUIDs and ACK nonces carry no `$`. A path can
 * (`host install --from '/tmp/${BUILD}/host.tar.gz'`, an `execPath` or a loader
 * script under such a directory), and there the honest answer is to refuse: on
 * 258 the value would silently become a different path, and `$$`-escaping it
 * instead would corrupt that same filename on every older systemd.
 *
 * Relocation runs before the command body validates anything, so this is the
 * only place that sees the composed argv.
 */
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

/**
 * Read our own cgroup membership, or refuse to answer.
 *
 * Every read failure is a FAILED CHECK, not a negative answer - ABSENCE
 * included. An absent `/proc/self/cgroup` (ENOENT, or ENOTDIR when `/proc` is
 * not a directory) says where this process cannot look, not where it is: a
 * mount namespace may hide procfs, or just this file (a sandboxed agent, a
 * wrapping unit's `TemporaryFileSystem=` or `InaccessiblePaths=`), while the
 * process still belongs to the cgroup it was born in and still reaches the
 * user manager through `$XDG_RUNTIME_DIR/systemd/private`, which needs no
 * procfs. Answering "not inside" there is exactly the stop that kills its
 * issuer (Codex on #1755, post-merge). A kernel built without cgroups omits the
 * file too, and refusing there costs nothing: the service registration this
 * guard protects is systemd-only, and systemd needs cgroups. No independent
 * marker rescues the case either: `sd_booted()`'s `/run/systemd/system/` is
 * namespace-local as well, and `TemporaryFileSystem=` hides it while leaving
 * `/run/user/<uid>` bound, so its absence proves nothing about the manager the
 * stop would reach.
 *
 * EACCES, EMFILE and EIO say nothing about membership either, and the earlier
 * blanket catch turned each of them into permission to stop: relocation would
 * be skipped, the guard would pass, intent would be written, and the stop
 * would kill the process issuing it. So every failure refuses, with the errno
 * recorded at DEBUG and absence named in the message because it is the case a
 * person can recognise (a sandbox) rather than a permission to fix.
 */
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
 * The parent WAITS. A person in a Traycer-hosted terminal keeps seeing output
 * through the inherited stdio until the stop kills their terminal; a
 * host-spawned parent dies with the cgroup, which is the expected end for it
 * and is why nothing here tries to shepherd the child beyond relaying a Ctrl-C
 * (`relayInterruptSignal`, which the detach makes necessary - and which
 * relays NOTHING else, least of all the SIGTERM this unit's own stop
 * delivers). Exiting immediately instead would lose that output and hand the
 * host's `exited` promise a false early settle.
 *
 * THE ACK IS WHAT SEPARATES the two failures that both arrive as an exit code.
 * Node's `spawn` event proves only that `systemd-run` started; a missing user
 * bus, a refused transient scope, or a failed exec of the target all happen
 * afterwards and show up as an ordinary non-zero `close`. Forwarding that code
 * would report a relocation that never delivered a CLI - no `E_SERVICE_CONTROL_FAILED`
 * envelope for a `--json` caller, and no relocated process alive to emit one -
 * while the log claimed the move had worked.
 *
 * So the relocated CLI writes one byte to fd 3 the moment it reaches
 * `withRunner` (`acknowledgeRelocationEntry`). An exit WITHOUT that byte is a
 * relocation that failed before the command started, and it rejects. An exit
 * WITH it is the command's own result and is forwarded verbatim, so the child
 * remains the only writer of a terminal envelope.
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
      // stdio 0-2 inherited, not piped: under `--json` the child owns the
      // NDJSON stream and this process writes nothing to it. fd 3 is the ack
      // channel and carries one byte in the other direction.
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      // The scope moves the child's CGROUP; it does not move its SESSION. In a
      // Traycer-hosted terminal the child would still be in the session whose
      // PTY the host owns, so the moment the stop closes that master the kernel
      // SIGHUPs the terminal's foreground group and takes the relocated updater
      // with it - the cgroup escape wasted. `detached` is setsid AT SPAWN, so
      // there is no window in which a handler has to be installed first, and
      // and `--scope` execs the CLI in place, so the process that lands in the
      // new session IS the relocated CLI - no supervisor is left behind in the
      // old one. The inherited fds come along, which is deliberate: progress stays
      // visible while the terminal lives, and the child tolerates it going away
      // (`acknowledgeRelocationEntry`).
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

/**
 * Forward a Ctrl-C - and ONLY a Ctrl-C - to the relocated child's process group.
 *
 * Only needed BECAUSE of the detach. While the child shared our process group,
 * a terminal's Ctrl-C went to both of us at once and no forwarding was called
 * for - which is why there never was any. `setsid` takes the child out of that
 * group, so without this relay Ctrl-C would kill the waiting parent and leave
 * the update running unattended: the opposite of the semantics it had.
 *
 * SIGTERM IS DELIBERATELY NOT RELAYED, and this is the whole reason the
 * function is named for one signal. This parent runs inside the host unit -
 * that is the only situation relocation exists for - and the stop the child was
 * sent away to perform is `systemctl --user stop`, whose default
 * `KillMode=control-group` SIGTERMs every process in that cgroup. Relaying it
 * would hand the child its own stop signal and kill the update at exactly the
 * moment the relocation exists to survive.
 *
 * The overwhelmingly likely SIGTERM here is therefore this unit dying - though
 * not provably so, since a person can always `kill -TERM` this pid directly.
 * The policy does not depend on telling those apart: in both cases the parent
 * takes the default action and dies, and in both cases the child outliving it
 * is the point. Only the provenance is uncertain, never the response.
 *
 * SIGHUP is not relayed either, and the policy is unconditional rather than
 * inferred from where the signal came from. A hangup here most often means the
 * PTY closed, which is a teardown the child was deliberately moved out of the
 * way of - it left that session at spawn and tolerates the lost fds
 * (`acknowledgeRelocationEntry`) - but it can also be sent by hand. Either way
 * it is not forwarded: nothing about a hangup delivered to THIS process is
 * evidence that the work in the other session should stop.
 *
 * The group (`-pid`), not the pid. `--scope` EXECS in place, so `child.pid` is
 * the relocated CLI itself and signalling the bare pid would in fact reach it -
 * but the CLI is not necessarily alone. `setsid` made it the leader of a new
 * group, and anything it spawns without detaching itself lands in that group
 * too, so `-pid` delivers to the whole thing a Ctrl-C would have hit had the
 * process never left the terminal's foreground group. That equivalence is the
 * point: the relay exists to preserve the semantics the detach took away, not
 * to invent narrower ones.
 *
 * Deliberately no `process.exit` here: the parent keeps waiting so the child
 * stays the only writer of a terminal envelope, and reports its code as always.
 * A consequence worth naming: while this listener is installed, Ctrl-C no
 * longer terminates THIS process the way an unhandled SIGINT would. It ends the
 * command all the same - the child takes the signal, dies, and its code is
 * reported here - but the parent outlives the keypress by however long the
 * child takes to go. That is the same trade the whole function makes: the child
 * is the thing running the work, so the child decides when there is an answer.
 *
 * There is one gap this cannot close, and it is deliberate: a SIGINT arriving
 * between `spawn` returning and this listener being installed still takes the
 * default action and kills the parent, leaving the child running unattended.
 * Closing it would mean installing a handler before there is a pid to forward
 * to. The outcome is the same as the SIGTERM case above - parent gone, work
 * continues - which is the behaviour this design already treats as correct.
 */
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
    // TWO INDEPENDENT FACTS, and neither implies the other:
    //
    //   - the process ENDED, and with what code (`exit`);
    //   - the ack channel is DONE, so no byte can still arrive (`end`).
    //
    // The obvious spelling - decide on `close`, which Node fires only once the
    // stdio streams are finished - is wrong on the runtime half of this
    // workspace. Bun counts stdout and stderr toward its close accounting but
    // returns the extra descriptor from `net.connect({fd})` without adding it,
    // so with stdio 0-2 inherited its `close` can fire while fd 3 still holds
    // unread bytes. Deciding there would reject a relocation that had already
    // acknowledged and completed - a false "never started", a second terminal
    // envelope, and the child's real exit code lost.
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
      // `end` is the ordinary finish; `close` covers a stream destroyed without
      // ending, and `error` a channel that broke. Any of the three means no
      // further byte is coming, which is all this flag claims.
      const finishAck = (): void => {
        if (ackFinished) return;
        ackFinished = true;
        settle();
      };
      ack.once("end", finishAck);
      ack.once("close", finishAck);
      ack.once("error", finishAck);
    } else {
      // No readable channel at all. Both supported runtimes hand back a
      // `net.Socket` here, so this is a runtime that cannot answer the
      // question. An unanswerable ack is treated as a missing one: the parent
      // rejects when the child exits rather than claiming an unconfirmed
      // command completed. That governs the PARENT's result only - the child
      // is already spawned and this does not cancel it.
      ackFinished = true;
    }
    child.once("error", (cause) => {
      reject(relocationFailed(logger, commandPath, inside, cause));
    });
    // `exit`, not `close`: this listener is about the process ending, and
    // nothing else. Whether the ack channel has drained is the other half,
    // tracked above.
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      settle();
    });
  });
}

/**
 * The relocated CLI's entry duties: say hello on fd 3, and stop depending on a
 * terminal that is about to be closed underneath it. Both belong at entry and
 * both are no-ops on an ordinary run, which is why they share the gate.
 *
 * Called first thing in `withRunner`, before the surface check, before argument
 * parsing, before anything the command does - the parent is waiting to learn
 * whether a CLI exists in the new scope at all, and every step taken before the
 * answer is a step that can fail while looking like `systemd-run` failing.
 *
 * Gated on the recursion flag, because fd 3 belongs to whoever launched us on
 * an ordinary run and must not be written to. Failures are swallowed: an older
 * parent leaves no pipe there (EBADF), and a CLI that cannot say hello must
 * still run the command it was asked to run.
 */
export function acknowledgeRelocationEntry(): void {
  if ((process.env[TRAYCER_CLI_RELOCATED_ENV] ?? "").length === 0) return;
  try {
    writeSync(RELOCATION_ACK_FD, RELOCATION_ACK_BYTE);
  } catch {
    // Nothing is listening, or the write failed. Neither changes what this
    // process was asked to do.
  }
  // The other half of surviving the stop. This process kept the terminal's fds
  // 0-2 but left its session, so when the stop closes the PTY master the writes
  // start failing with EIO instead of the process being SIGHUPed. An unhandled
  // `error` on `process.stdout` throws, which would kill the update at exactly
  // the moment the relocation exists to survive. There is nowhere left to
  // report a write failure to - the place we would report it to is what
  // vanished - so the only thing to do with it is nothing.
  //
  // fd 0 is deliberately left alone. Nothing on a host-stopping path reads
  // stdin, and merely TOUCHING `process.stdin` is not free: the getter
  // constructs the stream on first access, and on a TTY that is a ref'd handle
  // that can hold the event loop open past the work being done. A guard against
  // an error nobody can provoke is not worth a process that will not exit.
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
