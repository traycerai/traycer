# Q13 — nothing relaunches a CLI-only host after a stop-for-update

Owner: a08004f6. Branch `traycer/q13-stop-without-disarming`, stacked on the Q9
tip. Not pushed. **HOLDING-BRANCH ARTIFACT: `.q13/` must be dropped before this
reaches anything shared.**

## What was wrong

The update's pre-swap stop used the service manager's own stop verb. On Linux
`systemctl --user stop` puts the unit `inactive`, and `Restart=` does not apply
to a unit stopped that way — this repo already relies on that, in
`cancelScheduledAutoRestart`, which uses a stop _because_ it cancels a
scheduled relaunch. So the update turned the manager off with the manager's own
off-switch, and the only thing that turned it back on was the CLI that had just
promised the restart. Kill that CLI in between and nothing on a CLI-only
install ever brings the host back: the reconciler that could is inside the host
that is down.

The exit code was never the blocker. That was the first design's premise and it
was wrong.

## Commits

| SHA         | What                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `42990b536` | clean-exit gate: a `restart` intent → exit 77, four table-driven pins                                   |
| `52f01ca67` | the waiting supervisor: `waitMs` from a new shared budget leaf                                          |
| `2bdc33a7e` | the unit-text pin: `RestartSec` vs the start-limit arithmetic, `Type=simple`, no `TimeoutStartSec`      |
| `0e45966de` | the verb change: signal the unit, own the ladder, instance-bound confirmation, `forcedRecycle` inverted |
| `ea23f8911` | the ordering pin: confirm the instance we SIGNALLED                                                     |

## The three pieces, and why each is shaped the way it is

1. **A clean exit under a standing `restart` intent exits 77.** The fix site is
   NOT `decideRelaunch` — that is the abnormal-exit path and a clean exit never
   reaches it. It is `if (!outcome.abnormal) return exitSupervisor(outcome.exitCode)`,
   whose comment ("a clean exit is the host standing down on purpose") is the
   outage written as an invariant. A table-driven pin found this; neither design
   analysis got below "the exit-code contract".
   The key is `restart`, not `install-swap`. `install-swap` "deliberately
   promises no comeback" and rides the RPC leg, never a service stop.
2. **The supervisor WAITS on the attempt lock rather than being restarted at
   it.** At `waitMs: 0` a relaunched supervisor is refused instantly, restarted
   `RestartSec` later, refused again — ~10 spurious starts per healthy update.
   That traffic is also what makes a start-limit unusable: any limit tight
   enough to bound a stuck record is tripped by an ordinary update. Bounding the
   loop and removing it were the same decision.
3. **The stop signals the unit and owns its own ladder.** Confirmation is
   instance-bound, because with the manager armed both obvious alternatives are
   wrong: unit state never settles to `inactive`, and endpoint liveness is
   answered by the _replacement_.

## Per-platform expected behaviour (for the wedge matrix)

Only Linux is implemented. macOS and Windows are written here as the expected
behaviour the lanes should test against, NOT as claims about current code.

|                                     | Linux (systemd --user)                                         | macOS (launchd)                                                                     | Windows (Task Scheduler)                                                    |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| stop verb today                     | `systemctl --user stop` → unit `inactive`, `Restart=` disarmed | `launchctl` stop/bootout — **assumed** to disarm `KeepAlive`; UNVERIFIED            | `schtasks /End` — **assumed** to disarm `RestartOnFailure`; UNVERIFIED      |
| stop verb wanted                    | `systemctl --user kill --signal=SIGTERM` (job stays loaded)    | a signal that leaves the job loaded — `launchctl kill TERM <service-target>`        | signal the host process, not `/End` on the task                             |
| restart trigger                     | `Restart=on-failure`, `RestartSec=5`                           | `KeepAlive{SuccessfulExit:false}`, `ThrottleInterval: 10`                           | `RestartOnFailure`, finite restart COUNT                                    |
| non-zero exit relaunches?           | yes                                                            | **yes, already relied on** — `SERVICE_RELAUNCH_BUSY_EXIT_CODE`'s docblock states it | yes, up to the count                                                        |
| start deadline the wait could cross | none (`Type=simple`, no `TimeoutStartSec`) — pinned            | none                                                                                | none (only an execution-time limit, in days)                                |
| native pacing                       | `RestartSec=5`                                                 | `ThrottleInterval: 10` — halves the storm                                           | none; the finite count IS the bound, and the happy-path traffic consumes it |

**Windows is the one that needs its own row and its own thinking.** A finite
restart count is a bound, but the same happy-path retry traffic consumes it, so
a long update could exhaust the count and leave the task not running with
nothing left to trigger it. The waiting-supervisor change is what makes this
survivable — one start per update instead of ten — which is why Windows should
not ship the verb change without it.

## Cross-package / cross-platform conjunct table

| Conjunct                                                                            | Authority                                          | Watched by                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemctl stop` disarms `Restart=`                                                 | systemd                                            | **citation only** — but the repo's own `cancelScheduledAutoRestart` depends on it, which is corroboration from a second direction                                                                 |
| `systemctl kill` runs no stop job, so `TimeoutStopSec` does not apply               | systemd                                            | **citation only**, at the code. The ladder is correct ONLY if this holds                                                                                                                          |
| a kickstart of an already-running job no-ops                                        | launchd                                            | **citation only**, and load-bearing in BOTH directions — the hazard behind `forcedRecycle`'s inverted default, and the safety behind Q9's crash-during-activation admit. Cite each from the other |
| the update's stop announces `restart`                                               | `service/index.ts:518-520`                         | the four-row exit-code table                                                                                                                                                                      |
| `restart` is the only reason promising a comeback                                   | `protocol/config/host-stop-intent.ts:59`           | the same table — substituting `install-swap` reddens two rows                                                                                                                                     |
| `RestartSec` stays outside the default start-limit                                  | the shipped unit                                   | **pinned**, read back off the emitted artifact                                                                                                                                                    |
| no start deadline the wait can cross                                                | the shipped unit / plist / task XML                | **pinned for systemd only** (`Type=simple`, no `TimeoutStartSec`)                                                                                                                                 |
| the plain `host stop` still uses `systemctl stop`, so its 90s default is still live | `linux.ts`                                         | **pinned** — the true proposition, replacing a vacuous "the ladder sits under 90s"                                                                                                                |
| a supervisor that waits re-resolves its target after admission                      | `host-start.ts:1466` inside the admission callback | **citation at the call site**; the hoist it warns against is a call-site edit                                                                                                                     |

## Red-watches

| #      | Ablation                                      | Reddened                                                    |
| ------ | --------------------------------------------- | ----------------------------------------------------------- |
| RW-13a | the clean-exit gate removed                   | the `restart` exit-code row                                 |
| RW-13b | the gate keyed on `install-swap`              | TWO rows — `restart` drops to 0, `install-swap` jumps to 77 |
| RW-13c | `RestartSec=1`                                | the unit-arithmetic pin                                     |
| RW-13d | `TimeoutStartSec=30` added                    | the same pin, other half                                    |
| RW-13e | `stopForRestart` reverted to `systemctl stop` | three verb pins                                             |
| RW-13f | the SIGKILL escalation removed                | the escalation pin alone                                    |
| RW-13g | an unprovable instance treated as gone        | the Q14-shape pin alone                                     |
| RW-13h | the instance captured AFTER the signal        | the ordering pin alone                                      |
| RW-13i | the Linux relaunch uses `restart`, not `start` | the convergence pin alone                                  |
| RW-13j | `IgnoreNew` → `Parallel` in the task XML      | the Windows convergence pin alone                           |
| RW-13k | the Linux relaunch made to consume `forcedRecycle` | the inertness pin alone                                |

**RW-13h initially came back GREEN** and that is the finding: the ordering the
whole confirmation rests on was unpinned, because the mock answered the same
instance whenever it was asked. The pin now gives the manager a replacement
host that appears once the unit is signalled.

## Convergence (coordinator's pin 1) — `364759e53`

Leaving the manager armed means the executor stops being the only thing that
can start a host. At the moment the swap finishes and calls
`relaunchAfterRestart`, a supervisor the manager relaunched is already sitting
in the job's instance slot, WAITING on the attempt lock.

The incumbent check cannot arbitrate that. `host-start.ts:927` calls it a gate
that "runs exactly once", before the relaunch loop, and the admission callback
at `:1472` spawns without re-asking — so a supervisor admitted after a 60s wait
does not re-check whether a host appeared meanwhile. Convergence therefore
rests **entirely** on the relaunch verb no-opping against a live job:

| Platform | Relaunch verb | Why one host |
| --- | --- | --- |
| Linux | `systemctl --user start` | systemd no-ops a start job on an active unit. **Pinned.** |
| Windows | `schtasks /Run` | `MultipleInstancesPolicy: IgnoreNew` drops the second run. **Pinned.** |
| macOS | `kickstart` / `kickstart -k` by `forcedRecycle` | plain kickstart no-ops; `-k` recycles the waiter and launchd replaces it. Both single-instance. **Not yet pinned.** |

dc84fa8b relays that reviewer B found this same conjunct sitting under **Q9's**
three admit rows, where it was citation only and named as falsifiable by an
ordinary in-repo edit (`kickstart -k` unconditionally). Two thirds of it are
now pinned; the macOS third is the one B's falsifier actually names, so it is
the one still worth writing.

### `forcedRecycle` is inert on Linux, and the note should not imply otherwise

`forcedRecycle` has exactly one consumer: `kickstartDesktopAgent` on macOS
(`macos.ts:1804`, `:2534`, `:2537`). Linux and Windows both route
`relaunchAfterRestart` to `startService` and never read it. So B's H1 ruling —
which I implemented, inverting the default so an unprovable instance recycles —
is **correct but currently unread on the only platform I changed**.

Computing it honestly is still right: `RestartStop` is the cross-platform
contract, and this is the one field whose entire purpose is naming "we could
not tell". Windows can hard-code `false` and says why (its stop kills the tree
and waits); Linux cannot, because its stop genuinely may fail to prove the
instance gone. But "inert today" is the accurate claim, and it is now pinned as
such rather than left to be mistaken for live protection.

## Still owed

- **macOS half of pin 1**: `relaunchAfterRestart` picks plain `kickstart` when
  the instance was proven gone and `-k` when it was not. B's named falsifier.
- macOS and Windows verb changes, once the lanes verify the disarm assumptions.
- The `busy`-refusal logging cadence: one INFO per attempt id, DEBUG after, no
  account ids.
- The `StartLimit` numbers: **hold until the lane measures** the per-update
  supervisor start count. Reviewer B's point — the calculation is what produced
  the bound/traffic collision in the first place, and there are now two sources
  of starts (the mid-swap arrival at `host-start.ts:1052`, and the waiting
  relaunch) whose interaction is easier to measure than to predict.

## Process note, and it is the second instance

**I destroyed uncommitted work with `git checkout` during a red-watch again**,
this time the whole verb change in `linux.ts`. Rebuilt from the patch scripts,
nothing lost. The rule was already written in `.q9/NOTES.md` after the first
time and I broke it anyway. Restating it as an absolute: **commit before every
red-watch, no exceptions** — the ablate/restore cycle is only safe on a file
whose content is in HEAD.
