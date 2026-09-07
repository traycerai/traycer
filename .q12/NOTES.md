# Q12 — record the generation the swap itself wrote

Owner: a08004f6. Branch `traycer/q12-swap-generation`, stacked on the Q13 tip
(`3306e3330`). Not pushed. **HOLDING-BRANCH ARTIFACT: `.q12/` must be dropped
before this reaches anything shared.**

## The brief was wrong in three places, and the corrections shrank the ticket

| Brief said                     | Actually                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol key on my branch      | **no protocol change.** `AttemptAdvance.claimRefresh` already exists (`transition.ts:1048`) and `advanceAttempt` already applies it (`:1150`). The machinery is advance-generic, never park-specific |
| dc84fa8b told                  | nothing to tell them — no protocol file touched, no `contender.ts`                                                                                                                                   |
| older-decoder tolerance pinned | nothing new is decoded, so there is nothing to tolerate                                                                                                                                              |

The whole defect was one hard-coded `null`: `phaseWrite` passed
`claimRefresh: null` unconditionally, so `applying → restarting` — the single
advance that crosses a change of installed bytes — carried a baseline whose
install GENERATION its own swap had just superseded. (Generation, not
necessarily version: a same-version re-install mints a new install id, so the
version can still read correctly while the generation no longer names the live
install.)

## Commits

| SHA         | What                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| `b1719506e` | `phaseWrite(phase, claimRefresh)` required; the swap sites refresh; claimless pinned |
| `a54dbed81` | the activation arm carries rather than refreshes; the downgrade swap pinned          |

## The design

`phaseWrite`'s second parameter is **required**, not defaulted — AGENTS.md bans
optional params, and here that ban pays: **eight of the ten** call sites pass
`null`, and each is now a stated decision rather than an inherited one. (I first
wrote "six of the nine" — wrong in both numerator and denominator, caught by
ea8ce20c at the merge. Only the two arms that actually swap refresh.)

Only **two** arms actually swap:

| Arm             | Site    | Refreshes?             |
| --------------- | ------- | ---------------------- |
| `applyArm`      | `:1857` | yes — the primary path |
| `downgradeArm`  | `:2282` | yes                    |
| `activationArm` | `:2429` | **no — carries**       |

## The finding that changed the code, not just a test

I first refreshed at all three `restarting` writers. Then I ablated each one
**individually** rather than all together:

| Ablation                            | Result        |
| ----------------------------------- | ------------- |
| null the `applyArm` site alone      | 1 red         |
| null the `downgradeArm` site alone  | **163 green** |
| null the `activationArm` site alone | **163 green** |

Two thirds of the production change had nothing watching it. Following that up
found a genuine error rather than a missing test: **the activation arm does not
swap.** It stops the host and relaunches it onto bytes an earlier segment
placed, so asking it for "the generation the swap wrote" was a lie about where
the value came from. Reverted to `null`, which removes an unpinnable site
rather than leaving dead defensive code.

**My first comment for that revert was itself wrong, and B caught it.** I wrote
that "both births of an `activate` continuation refresh the baseline — the busy
park, and the recovery resume". There is exactly **one** origin:

- `resumedRecord` (`transition.ts:874`) spreads `...record` and never touches
  `claim`, so a recovery resume **inherits** rather than refreshing;
- the Desktop verify handoff creates none either and says so at its own
  `claim: null`, deferring to the executor's recovery park;
- that park is `parkForActivation` (`update-run.ts:2523`) — one of only two
  `writer.park` sites in the file, and the only one producing an `activate`
  continuation.

It is sound by construction rather than ordering luck: `readClaimRefresh` reads
the install record LIVE under the lock, so park-vs-swap order does not matter.

I had misremembered my own acceptance test as evidence of a second origin,
because it shows a fresh baseline appearing after `verifyHostUpdateAttempt` —
but that path routes into the same `parkForActivation`.

The `downgradeArm` genuinely swaps and is now pinned, on the sharpest available
case: the claim is taken against 2.0.0, the swap installs 1.0.0, and the two
cannot be confused for one another by accident.

## What Q12 does NOT do — and it lands on Q17

`refreshedClaimBaseline` **ignores a refresh on a record carrying no claim**,
deliberately: _"a legacy continuation cannot gain an authorization nobody ever
granted it."_ So a claim-less attempt gets **no** recorded generation from its
own swap, silently and correctly.

Any consumer wanting to trust an installed/running/target equality must gate on
**the claim being present**, not on Q12 having run. The coordinator is adding
"record carries a claim" to Q17's gate with c7a2d006.

Pinned on Q12's own `applying → restarting` edge rather than inherited from the
existing park row (`transition.test.ts:1409`), because the two edges are only
equivalent while the refresh stays phase-agnostic and nothing forces that.

## Meeting Q5 at the merge — strictly stronger, not conflicting

`installedByThisAttempt` is not in this lineage; it lives on the merged branch.
The interaction is real and it is benign:

`revalidateInstallIdentity` compares version **and** generation against the
baseline. With the swap's generation recorded, that primary check now succeeds
outright post-swap, so `installedByThisAttempt`'s forgiveness clause is
**bypassed rather than contradicted**.

**The clause must stay.** A record written by a pre-Q12 CLI still has a stale
baseline and still needs forgiving. Same reasoning blocks any move to make Q9's
`supervisorRelaunchOverActive` compare generations unconditionally — my own
comment there names Q12 as the missing mitigation
(_"the mitigation is not local — it is recording the generation the swap itself
wrote"_), but a pre-Q12 record still has nothing to compare, so the comparison
cannot become unconditional. **That docblock needs updating and I did not touch
it**: dc84fa8b is holding `contender.ts` for comment work, and editing the same
docblock concurrently is exactly what we agreed to avoid. Told them instead.

## An acceptance pin changed meaning, and the change is the deliverable

`update-run.test.ts:4549` used to assert a crash at `restarting` left a claim
naming the **pre-apply** install, commented _"only the refresh the recovery
park writes makes them equal"_. That was the defect written down as a property.
The baseline is now already at the target when the crash happens. The park's
own refresh (`:4563`) still passes — `parkForActivation` remains an origin, it
is just no longer the ONLY one.

## Q12 is BEST-EFFORT, and the gap is invisible at the record

`generationWrittenBySwap` returns `null` when the install record cannot be read
at `afterSwap`, so `phaseWrite("restarting", null)` carries the PRE-swap
baseline. Such a record is **indistinguishable at the record from one written
by a pre-Q12 CLI** — no reader can separate "Q12 ran and could not read" from
"Q12 never ran".

**So a fresh baseline is not an invariant of post-Q12 records**, and nothing may
be built on treating it as one. What covers the case is unchanged and lives on
the merged CLI lineage, not in this tree: `installedByThisAttempt`'s forgiveness
clause in `revalidateInstallIdentity`. That is a second, independent reason it
must stay — not only for genuinely pre-Q12 records.

Named in the `generationWrittenBySwap` docblock, in `phaseWrite`'s (a `null`
there is not evidence that nothing changed), and in the acceptance pin's
comment, so none of the three teaches an invariant that does not hold.

## A Q13 regression found at the merge, fixed here — `52810952c`

ea8ce20c's merge surfaced `linux-install-flow.test.ts:766` RED. **It was my
regression, not a stale pin.** Q13 replaced

    stopForRestart: (label, options) => stopService(label, run, options.force, "restart")

with a function taking **no `force` at all**, so on Linux `host restart --force`
silently stopped escalating to the published host and stopped REPORTING a
forced stop that had not taken effect.

The distinction the inversion blurred, and it is the useful part:

| State                                         | Meaning                          | Answer                                                      |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| signalled instance not provably gone          | we could not tell                | `forcedRecycle: true`; the relaunch recycles and repairs it |
| `--force`, and the forced stop reports `hung` | the stop **did not take effect** | reject — the caller explicitly asked to be told             |

The coordinator's reading of the name `SERVICE_CONTROL_FAILED` was right, and
it was right for the reason the name suggests: a service-control call that
failed is not the same fact as an instance that cannot be proven dead.

Restored as the LAST escalation rather than by reverting to `stopService`, so
Q13's property survives: the signal ladder still runs, the unit is never left
INACTIVE with `Restart=` disarmed, and only when the ladder cannot prove the
instance gone does `--force` reach the host process directly, outside the
unit's cgroup.

**Pinned from both sides.** The twin row is the one worth keeping: wiring the
escalation unconditionally would reach for the published host on every ordinary
update restart — and with the manager left armed, `pid.json` by then may name
the REPLACEMENT systemd has already started rather than the instance we
signalled. That is the same hazard `ea23f8911` pinned for the confirmation,
arriving at a second site. One-sided pins are how the first regression got in.

| #     | Ablation                           | Reddened                 |
| ----- | ---------------------------------- | ------------------------ |
| RW-F1 | the force escalation removed again | the force row alone      |
| RW-F2 | the escalation made unconditional  | the non-force twin alone |

## Red-watches

| #       | Ablation                                 | Reddened                                          |
| ------- | ---------------------------------------- | ------------------------------------------------- |
| RW-12a  | all three `restarting` writers nulled    | 1 (which is how the gap was found)                |
| RW-12a′ | each site nulled ALONE                   | applyArm 1 red; the other two green → the finding |
| RW-12b  | claimless records gain a minted claim    | both claimless pins                               |
| RW-12c  | consent restated instead of copied       | 2 shared + 2 CLI, including my new downgrade pin  |
| RW-12d  | `applyArm` site alone, after the fix     | 1 red                                             |
| RW-12e  | `downgradeArm` site alone, after the fix | 1 red                                             |

## Suites

`transition` 125/125, `update-run` 164/164, `contender` 90/90, `tsgo` clean.

## Owed

- Tell dc84fa8b the `supervisorRelaunchOverActive` docblock now needs its
  "until that exists" sentence updated — Q12 exists.
- The detective half of the compatibility fence, queued next.
