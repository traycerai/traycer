import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
} from "@traycer/protocol/host/lifecycle-constants";

/**
 * The spawn-edge bounds, every CLI-local timing they are derived from, and the
 * host-start grant window derived from them (`service/spawn-edge.ts` says
 * what an edge is).
 *
 * A LEAF, on purpose and pinned (`__tests__/spawn-edge-bounds-leaf.test.ts`):
 * its one import is protocol's `host/lifecycle-constants`, which imports
 * nothing, so this module can never sit on an import cycle. The window needs
 * exactly that. It is computed at module load, and the released CLI is an
 * esbuild CJS bundle, where a cycle does not throw - the early reader of a
 * top-level `const` gets `undefined` - so a window derived from a module still
 * mid-evaluation would ship as `NaN`, and a `NaN` window never expires a grant.
 * The platform controllers, `host/host-start-adoption.ts` and the supervisor's
 * post-mortem (`commands/host-start.ts`) import from here; nothing here
 * imports them.
 */

// --- launchd -----------------------------------------------------------------

/**
 * The runner timeout for a `launchctl` call that waits on no job's process -
 * `print`, a bare `bootout`, `bootstrap`, a plain `kickstart`, `kill`: long
 * enough for `launchctl` to spawn, reach launchd over XPC and return.
 */
export const LAUNCHCTL_CALL_TIMEOUT_MS = 10_000;

/**
 * `installService`'s kickstart. 30s, not 10s: the dev wrapper at
 * ~/.traycer/cli/dev/bin/traycer exec's `bun src/index.ts` - bun cold-start
 * across ~2500 TS files plus the host's first-boot work can comfortably
 * exceed 10s on a loaded laptop.
 */
export const LAUNCHCTL_INSTALL_KICKSTART_TIMEOUT_MS = 30_000;

/**
 * The plist's `ThrottleInterval`, in SECONDS, and the reason it is a named
 * export rather than an inline literal in the template (`buildPlist` in
 * `platforms/macos.ts`).
 *
 * launchd will not respawn this agent more often than this, so it is the
 * earliest a `KeepAlive` relaunch can possibly reappear - which every caller
 * that avoids `kickstart -k` already reasons about (see `registerService` and
 * the eviction repair), and which the host-update verify leg must wait out
 * before it may conclude that a failed service start means the host is never
 * coming back. Two places deriving that bound from one number cannot drift;
 * two places writing `10` can, and silently.
 */
export const LAUNCHD_THROTTLE_INTERVAL_SECONDS = 10;

/**
 * The most launchd may wait, in SECONDS, between the SIGTERM a recycle sends
 * the job and the SIGKILL it escalates to: the job's `ExitTimeOut`.
 *
 * Neither plist that registers the host sets that key - `buildPlist`, and
 * Desktop's SMAppService plist (`inject-host-launch-agent.cjs`) - so the job
 * runs on launchd's default, which Apple documents only as "system-defined".
 * Current launchd prints `exit timeout = 5` for these jobs (the captured
 * `launchctl print` fixtures in `clients/shared/host-lifecycle`, our own
 * SMAppService agent among them); the open-source launchd's default was 20. So
 * 20 is a CEILING, not the observed value: a release that moves the default
 * back toward it must not reopen a false failure.
 */
const LAUNCHD_EXIT_TIMEOUT_CEILING_SECONDS = 20;

/**
 * Headroom above launchd's own bounds for `launchctl` itself to spawn, reach
 * launchd over XPC and return - the same bound every other launchctl call is
 * given in full.
 */
const LAUNCHCTL_RECYCLE_MARGIN_MS = LAUNCHCTL_CALL_TIMEOUT_MS;

/**
 * The runner timeout for a recycle (`launchctl kickstart -k`), derived from
 * what launchd itself may make that call wait for.
 *
 * `kickstart -k` does the whole recycle before it returns: it SIGTERMs the
 * running job, waits for it to exit - SIGKILL at `ExitTimeOut` - and then
 * starts it again, a start launchd may hold back by up to `ThrottleInterval`
 * (why `installService` avoids `-k` on a healthy host). The job's process is
 * the `host start` supervisor, so on a restart there is always an exit to
 * wait for: the stop leaves the supervisor either mid post-mortem, or already
 * relaunched by `KeepAlive` - a `restart` stop intent makes it exit non-zero
 * (`RESTART_OWED_EXIT_CODE` in host-start.ts) so the manager owes the
 * comeback - and a relaunched job is inside its throttle window when the
 * recycle's start comes due.
 *
 * (20s ExitTimeOut ceiling + 10s ThrottleInterval) + 10s margin = 40s. The
 * recycle is a spawn edge - the grant is published immediately before it - so
 * this is one of the bounds the host-start adoption window is derived from,
 * and the supervisor it starts finds its grant by construction.
 *
 * It was 10s - shorter than launchd's own bound. When that fired, the CLI
 * killed `launchctl`, which withdraws nothing launchd had accepted, and
 * reported a failed restart that launchd then finished (field, 2026-09-22:
 * `kickstart -k` timed out at 10s and the new host was up 3s later). A
 * timeout past THIS budget is not launchd being slow within its rules, so it
 * stays a failure - but one reported as unconfirmed, never as a restart that
 * failed (`recycleFailure` in `platforms/macos.ts`).
 */
export const LAUNCHCTL_RECYCLE_TIMEOUT_MS =
  (LAUNCHD_EXIT_TIMEOUT_CEILING_SECONDS + LAUNCHD_THROTTLE_INTERVAL_SECONDS) *
    1_000 +
  LAUNCHCTL_RECYCLE_MARGIN_MS;

/**
 * The longest macOS `installService` can run from its install edge to the
 * return of its last spawn edge - the longest path of any platform, so the one
 * the window is sized by.
 *
 * The install edge sits in front of the install's first write, so a refused
 * publication touches nothing (`atServiceInstallEdge`). After it: the
 * launcher and plist writes (local files, no subprocess), the bare `bootout`
 * of a loaded registration, then `bootstrap` (`RunAtLoad` launches the
 * supervisor from it). When that loses the reload race,
 * `reloadRegisteredService` re-probes, boots out and bootstraps again, and on a
 * second benign failure probes once more; the kickstart comes last. Every step
 * runs to its own timeout in the worst case, so a launch can come as late as
 * the kickstart's return:
 *
 *     bootout (loaded registration)  10s
 *   + bootstrap                      10s  (spawn edge 1)
 *   + print (race re-probe)          10s
 *   + bootout                        10s
 *   + bootstrap                      10s  (spawn edge 2)
 *   + print (post-race)              10s
 *   + kickstart                      30s  (spawn edge 3)
 *   = 90s
 *
 * The two ownership probes in front of the install edge are not counted.
 */
export const LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS =
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_CALL_TIMEOUT_MS +
  LAUNCHCTL_INSTALL_KICKSTART_TIMEOUT_MS;

// --- systemd -----------------------------------------------------------------

/**
 * Budget for the crash-report scan that runs BEFORE the synchronous terminal
 * marker write. The marker is readiness authority and must not be lost to a
 * slow disk - past the budget the marker is written without a `report=`.
 *
 * Here, not beside the crash diagnostics it budgets, because it is a term of
 * the systemd stop bound below.
 */
export const CRASH_REPORT_SCAN_TIMEOUT_MS = 2_000;

/**
 * Budget for draining queued stderr tee writes before the terminal marker.
 * Here for the same reason as `CRASH_REPORT_SCAN_TIMEOUT_MS`.
 */
export const STDERR_FLUSH_TIMEOUT_MS = 1_000;

/**
 * Budget for waiting on the child's stderr stream to END before the terminal
 * marker is written. `exit` fires when the process dies, NOT when its pipes
 * have drained, so finalizing on `exit` can write the marker while the fatal
 * text is still unread in the pipe - the capture is then empty in exactly the
 * abnormal-death case it exists for. Bounded because a grandchild holding the
 * inherited stderr fd can delay `close` indefinitely, and a diagnostics path
 * must never be able to hang the supervisor's exit: wait, then write whatever
 * has arrived. Here for the same reason as `CRASH_REPORT_SCAN_TIMEOUT_MS`.
 */
export const STDERR_END_WAIT_TIMEOUT_MS = 2_000;

/**
 * The unit's `TimeoutStopSec`, in SECONDS: how long systemd lets a stop job
 * run between the SIGTERM it sends the unit's cgroup and the SIGKILL it
 * escalates to. Pinned in `buildUnit` (`platforms/linux.ts`) rather than left
 * to systemd's default (90s, or whatever `DefaultTimeoutStopSec` a distro or
 * user.conf sets) so the bound every blocking `systemctl` job waits on is one
 * this file names.
 *
 * Derived from what a deliberate stop legitimately takes, so it never cuts one
 * short - the host's shutdown, then the supervisor's post-mortem once its
 * child is gone, then headroom:
 *
 *     SHUTDOWN_FORCE_EXIT_MS       30s  host force-exit watchdog (protocol
 *                                       host/lifecycle-constants.ts)
 *   + STDERR_END_WAIT_TIMEOUT_MS    2s  above
 *   + STDERR_FLUSH_TIMEOUT_MS       1s  above
 *   + CRASH_REPORT_SCAN_TIMEOUT_MS  2s  above
 *   + STOP_EXIT_GRACE_MARGIN_MS     2s  protocol host/lifecycle-constants.ts
 *   = 37s
 *
 * The three post-mortem terms are the ones `runHostStart` awaits after its
 * child dies (host-start.ts names them where it stamps the child's death);
 * crash telemetry is fire-and-forget and not waited for.
 *
 * The margin is counted once. On a stop job the signaller owns the
 * escalation - systemd SIGTERMs the cgroup and the supervisor only forwards,
 * arming no SIGKILL of its own (host-start.ts) - so the host's watchdog is the
 * bound and `STOP_EXIT_GRACE_MARGIN_MS` is pure slack. The supervisor spends
 * that same margin as its own kill grace (`RACED_STOP_KILL_GRACE_MS`) only on
 * the raced path, which runs no stop job.
 *
 * Existing units adopt it when `installService` next re-registers them -
 * `host service install`, and the post-swap re-register of an existing
 * registration that `host update` / `host install` / ensure / apply run - and
 * keep systemd's default until then.
 *
 * The emitted value is part of `SYSTEMD_UNIT_SERVICE_DIRECTIVES`, and so part
 * of what the host's unit reader must admit (see there).
 */
export const SYSTEMD_TIMEOUT_STOP_SECONDS = Math.ceil(
  (SHUTDOWN_FORCE_EXIT_MS +
    STDERR_END_WAIT_TIMEOUT_MS +
    STDERR_FLUSH_TIMEOUT_MS +
    CRASH_REPORT_SCAN_TIMEOUT_MS +
    STOP_EXIT_GRACE_MARGIN_MS) /
    1_000,
);

/**
 * The runner timeout for a `systemctl` verb that queues no job - `daemon-reload`,
 * `show-environment`, `is-active`, `disable`: long enough for `systemctl` to
 * reach the user manager over D-Bus and return.
 */
export const SYSTEMCTL_CALL_TIMEOUT_MS = 10_000;

/**
 * The runner timeout for every `systemctl` verb that queues a start or restart
 * job, derived from the stop bound above.
 *
 * `systemctl` waits for the job it queues. A `restart` job is a stop followed
 * by a start, and a `start` - `enable --now` included - queues behind a stop
 * already in flight: after a restart's stop the unit can sit deactivating
 * while systemd SIGTERMs whatever is left in the cgroup. So any of these can
 * block for the whole stop bound before its start begins.
 *
 * 37s TimeoutStopSec + 15s = 52s, the 15s being what these calls had for the
 * start alone. Each of these calls is a spawn edge - the grant is published
 * immediately before it - and the stop is SIGKILL-bounded at 37s while a
 * `Type=simple` start is immediate, so this is also the longest a Linux start
 * or restart can take to launch its supervisor after publishing.
 *
 * It was 15s - shorter than systemd's own bound. A slow but healthy stop then
 * killed `systemctl`, which withdraws nothing systemd has queued, and reported
 * a failure systemd went on to complete. A timeout past THIS budget is still a
 * failure, but reported as unconfirmed (`systemctlJobFailure`) - and so is a
 * stop in the 52-90s gap on a unit not yet re-registered with the pin, which
 * still runs on systemd's default.
 */
export const SYSTEMCTL_JOB_TIMEOUT_MS =
  SYSTEMD_TIMEOUT_STOP_SECONDS * 1_000 + 15_000;

/**
 * The longest Linux `installService` can run from its install edge, in front
 * of the unit write, to the launch: the unit write (a local file),
 * `daemon-reload`, then the `enable --now` job - 10s + 52s = 62s.
 */
export const SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS =
  SYSTEMCTL_CALL_TIMEOUT_MS + SYSTEMCTL_JOB_TIMEOUT_MS;

// --- Task Scheduler ----------------------------------------------------------

/** The runner timeout for the install's `schtasks /Create`. */
export const WINDOWS_SCHTASKS_CREATE_TIMEOUT_MS = 30_000;

/**
 * The longest a Windows start can take to launch its supervisor after its
 * spawn edge at `/Run`.
 *
 * `/Run` returns once the scheduler ACCEPTS the request; the launch itself is
 * asynchronous. A start that succeeds has seen post-baseline spawn evidence
 * inside the verify window, so its supervisor launched by then: `/Run`'s 30s
 * + the 15s verify = 45s. A launch later than that has already failed the
 * start, and its child can only be adopted inside the parent's ack wait.
 *
 * On a restart, `/End` and the whole scan-then-kill loop run before the edge,
 * off the grant's clock.
 */
export const WINDOWS_RUN_SPAWN_EDGE_BOUND_MS =
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS + WINDOWS_START_SPAWN_VERIFY_MS;

/**
 * The longest Windows `installService` can run from its install edge, in front
 * of the launcher write and `/Create`, to the launch: the staging writes
 * (local files), `/Create`, then the verified `/Run` - 30s + 45s = 75s.
 */
export const WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS =
  WINDOWS_SCHTASKS_CREATE_TIMEOUT_MS + WINDOWS_RUN_SPAWN_EDGE_BOUND_MS;

// --- The host-start grant window ---------------------------------------------

/**
 * What one CLI cold start of the service launcher may cost. The dev wrapper
 * exec's `bun src/index.ts`, and a bun cold start across ~2500 TS files "can
 * comfortably exceed 10s on a loaded laptop" (the reason `installService`'s
 * kickstart gets 30s); a packaged SEA takes about a second. The bound is the
 * dev one, so a slow machine is not a false refusal.
 */
const LAUNCHER_CLI_COLD_START_MS = 10_000;

/**
 * CLI cold starts between the OS manager launching the service launcher and
 * the supervisor consuming its grant, on the nonce-bearing path every launcher
 * takes (`buildHostStartLauncherScript`, Desktop's
 * `inject-host-launch-agent.cjs`, the Windows VBS): `host capabilities --has
 * service-label`, `host capabilities --has host-start-adoption-v2`, `host
 * adoption-nonce`, and `host start` itself.
 */
const LAUNCHER_CLI_COLD_STARTS = 4;

/**
 * From the supervisor's launch to its consume: 4 x 10s = 40s. The ONE source
 * for the launch cost, used by both the grant window and the parent's ack
 * wait below.
 */
export const SUPERVISOR_LAUNCH_MARGIN_MS =
  LAUNCHER_CLI_COLD_STARTS * LAUNCHER_CLI_COLD_START_MS;

/**
 * From the consume to the acknowledgement: the supervisor's target resolution,
 * its synchronous `spawn()` of the host, the parent-liveness re-check and the
 * acknowledgement write. Local work inside the process that already paid its
 * cold start.
 */
export const SUPERVISOR_SPAWN_ACK_MARGIN_MS = 10_000;

/**
 * The longest any controller call takes from its first edge (where the grant
 * is published, `service/spawn-edge.ts`) to the launch of the supervisor that
 * consumes it: the max over every path's bound.
 *
 *   macOS install (install edge, bootout, reload race)  90s  the max
 *   Windows install (`/Create` + verified `/Run`)       75s
 *   Linux install (`daemon-reload` + `enable --now`)    62s
 *   Linux start / restart job                           52s
 *   Windows start / restart (verified `/Run`)           45s
 *   macOS recycle (`kickstart -k`)                      40s
 *   macOS plain kickstart                               10s
 *
 * Everything a call does BEFORE its first edge - ownership probes, a Desktop
 * host's cooperative stand-down, the Windows stop ladder - is off the grant's
 * clock, which is what makes this bound finite at all.
 */
export const HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS = Math.max(
  LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS,
  SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  SYSTEMCTL_JOB_TIMEOUT_MS,
  WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_RECYCLE_TIMEOUT_MS,
  LAUNCHCTL_CALL_TIMEOUT_MS,
);

/**
 * `value`, once it is proven a finite duration; throws otherwise. The window
 * and the ack wait pass through it at module load, so a term that is ever
 * `undefined` or `NaN` fails the CLI at startup - and the development lane's
 * packaged smoke with it - instead of shipping a window no grant expires in.
 */
export function finiteDurationMs(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} is not a finite duration (${String(value)}): a term it is derived from was read before it was defined, or is not a number`,
    );
  }
  return value;
}

/**
 * How long a published grant stays usable: 90s + 40s = 130s. Derived, not
 * chosen - the latest a supervisor can be launched after its grant was
 * published, plus what its launcher takes to consume it.
 *
 * It was 60s, and a longer window used to cost something: a proof whose
 * publisher died refused every nonce-less launch until it expired, so widening
 * the window widened that wedge. The consumer now reads a proof whose parent
 * capability is not live as absent on exactly those paths (see
 * `consumeHostStartAdoption`), so the window no longer bounds any refusal - it
 * bounds how long a LIVE publisher's grant can wait for its child, and how
 * long a proof whose cancel failed can outlive its lease.
 *
 * A lease can outlive the window, by at most `SUPERVISOR_SPAWN_ACK_MARGIN_MS`.
 * The ack wait starts when the controller call returns - no earlier than the
 * launch it requested, and at most the bound above after the edge - so it
 * ends by bound + launch margin + ack margin = this window + the ack margin:
 * the macOS install whose kickstart times out ends at 140s, a Windows install
 * whose verify fails at 135s. That is the safe direction. Every supervisor the
 * window admits consumes inside it and acknowledges inside the lease; a claim
 * arriving after the window reads as expired and takes ordinary admission,
 * exactly as a launch with no proof does, and the parent waits at most the ack
 * margin longer for an ack that cannot come, then cancels. The unsafe
 * direction - a valid proof that no parent honours any more - arises only
 * through a failed cancel, and this window is what bounds it.
 */
export const HOST_START_ADOPTION_MAX_AGE_MS = finiteDurationMs(
  "HOST_START_ADOPTION_MAX_AGE_MS",
  HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS + SUPERVISOR_LAUNCH_MARGIN_MS,
);

/**
 * How long the parent waits, after its controller call returns, for the
 * supervisor to acknowledge its spawn: 40s + 10s = 50s. The call returns at or
 * after the launch, so this has to cover the whole launcher and the
 * supervisor's own spawn - and never be shorter than the launch margin the
 * window above already grants. It was 30s: a launch the window admitted could
 * miss it, and the parent then cancelled a child it had just started.
 */
export const HOST_START_ADOPTION_ACK_WAIT_MS = finiteDurationMs(
  "HOST_START_ADOPTION_ACK_WAIT_MS",
  SUPERVISOR_LAUNCH_MARGIN_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS,
);
