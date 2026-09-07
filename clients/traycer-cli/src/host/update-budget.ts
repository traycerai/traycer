/**
 * How long one update segment may take, in the two places that have to agree
 * about it.
 *
 * A leaf module on purpose. The value is read by the update run (which spends
 * it) and by the supervisor's start admission (which waits out someone else
 * spending it), and those two live on opposite sides of the CLI: `host start`
 * must not import the update run, and the update run must not import the
 * supervisor. A shared constant with no other imports is what lets both hold
 * the same number without either depending on the other.
 *
 * They cannot be allowed to drift, because the failure is silent in one
 * direction: a supervisor whose wait is shorter than the segment it is waiting
 * for gives up on a perfectly healthy update, exits non-zero, and is restarted
 * to wait again - turning one start into a stream of them, which is exactly
 * the retry storm the wait exists to remove.
 */

/**
 * The verify leg's budget: how long `host update` waits for the host to come
 * back up and report healthy before it calls the attempt failed.
 *
 * The longest single leg of a segment, and the one the supervisor's wait is
 * sized against.
 */
export const VERIFY_BUDGET_MS = 45_000;

/**
 * Headroom over `VERIFY_BUDGET_MS` for the legs around it - the cooperative
 * stop, the swap's renames, the relaunch - so a supervisor that starts at the
 * worst moment still outlasts a healthy segment rather than expiring inside
 * one.
 *
 * Not sized to cover a DOWNLOAD, deliberately. A download can take minutes on
 * a slow link, and a supervisor is not required to sit through it: an expiry
 * is not a failure, it is a pacing decision. The supervisor exits non-zero,
 * the service manager starts another one, and that one waits again. The wait
 * therefore sets the CADENCE of the retry loop rather than a total budget -
 * one start a minute instead of one every `RestartSec` - and the only thing a
 * too-small value costs is more starts.
 */
const SUPERVISOR_ADMISSION_WAIT_MARGIN_MS = 15_000;

/**
 * How long a supervisor start waits for an in-flight update segment before
 * giving up and handing itself back to the service manager.
 *
 * ## Why a supervisor waits at all (Q13)
 *
 * With the update's stop no longer disarming the service manager, a
 * relaunched supervisor arrives while the update that stopped the host is
 * still running. It contends for the attempt lock, which a live executor
 * segment holds for its whole span, and gets `busy`.
 *
 * With `waitMs: 0` that refusal is instant, so the supervisor exits, the
 * manager restarts it `RestartSec` later, and it is refused again - roughly
 * ten spurious starts across one healthy update. That traffic is not merely
 * noisy: it makes the start-limit unusable, because any limit tight enough to
 * bound a genuinely stuck record is tripped by an ordinary update. Bounding
 * the loop and removing the loop were the same decision, and removing it is
 * the one that leaves a limit available for real refusals.
 *
 * So: one start, one wait, one admission. On the happy path the segment
 * finishes inside this window and the supervisor is admitted - or finds the
 * host already up and declines to the incumbent - without the manager ever
 * being asked again.
 *
 * ## Why it is safe to wait this long
 *
 * No service manager we register with imposes a start timeout this could
 * cross - and each for a different reason, which matters because it decides
 * what to watch.
 *
 * systemd: the unit is `Type=simple`, which systemd considers started as soon
 * as it forks. There is no start-up completion to report, so no deadline
 * exists to cross. The unit also sets no `TimeoutStartSec`, but the two are
 * not equally load-bearing: under `Type=simple` a `TimeoutStartSec` has no
 * start-up signal to wait for, so ADDING one would not by itself put this wait
 * at risk. The TYPE is the trigger. `Type=notify` (or `forking`) introduces a
 * start deadline where none existed, and only then does a `TimeoutStartSec` -
 * or, in its absence, systemd's 90s default - bound a healthy wait.
 *
 * launchd: no start deadline of any kind.
 *
 * Windows: the Scheduled Task emits `<ExecutionTimeLimit>PT0S`, and PT0S means
 * NO limit in Task Scheduler rather than a zero-length one - the task may run
 * indefinitely. (This paragraph previously said the limit was "measured in
 * days", which is Task Scheduler's default of P3D for a task that HAS a limit;
 * ours deliberately does not.)
 *
 * All three are pinned rather than asserted - see the unit-text pins beside
 * each emitter - because each is one line of an emitted file, and the change
 * that flips it will not look like a change to this constant.
 */
export const SUPERVISOR_ADMISSION_WAIT_MS =
  VERIFY_BUDGET_MS + SUPERVISOR_ADMISSION_WAIT_MARGIN_MS;
