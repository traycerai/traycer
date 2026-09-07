# Q5 / Linux E6L — recovery after a kill mid-`restarting`

Owner: ticket-02 agent (a08004f6). Paused mid-work for the Mac matrix restart.

## Where the work is

- Worktree: `~/.traycer/worktrees/traycer-oss-cutover-02`
- Holding branch: `traycer/q5-recovery-target-equal`, **based on OSS `a05d40885`**
- **COMMITTED** as `9ddf128b9` (superseding this section's original "nothing
  committed"). `q5-e6l-recovery.patch`, `snapshot/` and `git-status.txt` are
  the PRE-hook-format text kept for reference only — **read the commit.**

## State (all three defects done, reviewed, committed)

- All three defects implemented, 170/170 on
  `src/host/__tests__/update-run.test.ts`, `tsgo --noEmit` clean, seven pins
  red-watched (RW1–RW7 below), reviewed and upheld by B.
- Read **DISPATCH**, **REVIEWER B'S VERDICT** and **Resume checklist** at the
  bottom of this file first; the sections above them are the original
  derivation and are still accurate except where B corrected them (B1 corrects
  the "third clause is unreachable on a park" claim below; B2 corrects the
  "lock acquisition precedes selection" holder argument below).

```
ps -eo pid,args= | grep -Ei "vitest|esbuild"     # must be clear first
cd clients/traycer-cli && bunx vitest run src/host/__tests__/update-run.test.ts
```

## The three defects and what was changed

### 1. The install moved to this attempt's OWN target and was called foreign

`revalidateInstallIdentity` (`host/update-run.ts`) compared the live install
record only against the CLAIM baseline. After a kill mid-`restarting` the
baseline still names the PRE-swap install (1.4.2) while the disk is at the
target (1.4.3), so the attempt's own successful swap read as a foreign change:
`failed {install-changed}`, host left down, every later run refused.

Fix: new `installedByThisAttempt(record, baseline, live)` — accepted when

- `record.continuation === "activate"`, and
- `live.version === record.targetVersion`, and
- `baseline.installedVersion !== record.targetVersion`.

Findings behind that shape, both load-bearing:

- **The phase cannot carry "past the swap".** `resumedRecord` lands EVERY
  recovery resume at `preparing`, so the `restarting`/`verifying` the killed
  run left is gone before this code runs. A phase test here never fires. The
  CONTINUATION carries it, and it is not testimony: `recoveryContinuation`
  returns `activate` only when the installed artifact is attested-verified at
  the record's own target, hashed under the same lock.
- **The third clause is required.** Without it two existing ticket-04 pins go
  red ("an activation park whose install was REMATERIALIZED at the same
  version is terminalized before any restart", and its plain-`install` twin):
  a park whose baseline was already refreshed to the target must still be
  decided by the install GENERATION. Only the pre-swap baseline → target step
  is forgiven.

### 2. A present record whose holder is dead reported as `refused-attempt-gone`

`selectBoundResume` released `refused-attempt-gone` for any non-parked record,
so `--intent continue --expect-attempt <id>` exited **0** while that exact id
sat on disk at `restarting` — indefinitely, because on a CLI-only install
nothing else runs the recovery (the reconciler is inside the dead host).

Fix: an ACTIVE id-matched record is now CLAIMED via new `interruptedResume`,
and the core decides (`requires-recovery` → the recovery arm). Holder
disposition is already proven separately: lock acquisition precedes selection,
so a live holder would have refused admission before the selector ran.

`interruptedResume` carries the VERB's action (`continue` → `continue`,
`activate` → `activate`) rather than `resumeSelection`'s unconditional
`continue`. That is the safety argument, and it is the same hazard reviewer B
blocked on the CLI owner's P2 patch: `actionMayResume("continue", …)` is
unconditionally true, so an `activate` claiming with `continue` could resume a
`resume-apply` continuation and apply a stage nobody named.

### 3. The release line named the INSTALLED version, and exited 0 over a dead host

`host stays at <installed>` was true about the bytes and false about the
machine. Fixes:

- `HostUpdateRunOutcome` gains `runningVersion: string | null`, read on the
  release path from `classifyActivationAgainst` (new `runningVersionOf`).
- `humanSummary` renders `the running host is X` / `no host is running (X is
installed)` (new `runningState` in `commands/host-update.ts`).
- A BOUND verb that releases while nothing is running now throws
  `E_HOST_NOT_RUNNING` (exit 1). The plain `install` verb is deliberately
  exempt — its no-op arms are the up-to-date path every healthy machine takes.
  The ACK still carries the release reason: the exit code is about the
  machine, not about the claim.

## Pins added (all in `src/host/__tests__/update-run.test.ts`)

Shared fixture: the existing `crashAtRestarting(target)` helper — killed after
the swap, install at the target, host not back. That IS the E6L wedge.

1. `Q5: killed at 'restarting' with the host still DOWN …` — completes on the
   same attempt, host up on target, no re-apply. RED without defect-1's fix.
2. `Q5 control: an install moved to a THIRD version under an activation park …`
   — still `install-changed`. Keys the fix to target-equality, not to "any
   activation continuation".
3. `Q5 control: killed BEFORE the swap …` — `resume-apply` runs as it did.
4. `Q5 defect 2: '--intent continue' on the wedged attempt RECOVERS it …`
5. `Q5 defect 2 control: … an attempt that really IS gone still answers
refused-attempt-gone` (same wedge, different id).
6. `Q5 defect 2 control: '--intent activate' carries its OWN action …` — a
   `resume-apply` wedge is refused, no stage applied.
7. `Q5 defect 3: a bound verb that declines while NO host is running …` —
   `E_HOST_NOT_RUNNING`, ACK still `refused-unverifiable`, park untouched.

Deliberately updated (not weakened): `the shell's summary for a release names
the reason the dispatcher was given` now expects `the running host is 1.0.0`
and asserts the sentence does NOT contain the installed `2.0.0` — that
sentence is the thing defect 3 changed.

## Red-watches (all run 2026-09-07 after the second wake; restored byte-exact,

## verified by shasum against `.q5-e6l/snapshot/`)

| #   | Ablation                                                     | Reddened                                                                                                                                        |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| RW1 | the whole `installedByThisAttempt` arm removed               | Q5 defect-1 pin + Q5 defect-2 pin (2 red)                                                                                                       |
| RW2 | clause `continuation === "activate"` dropped                 | the three consumed-stage park pins (2 terminalization pins + the "after the terminalization a plain host update starts the debt arm" follow-on) |
| RW3 | clause `baseline.installedVersion !== targetVersion` dropped | the two ticket-04 REMATERIALIZED activation-park pins                                                                                           |
| RW4 | defect 2 reverted to `{release, refused-attempt-gone}`       | Q5 defect-2 pin + the `--intent activate` control                                                                                               |
| RW5 | `interruptedResume` claims with an unconditional `continue`  | the `--intent activate` control ALONE - it applies the stage it never named (reviewer B's P2 hazard, reproduced)                                |
| RW6 | the bound-verb `E_HOST_NOT_RUNNING` throw removed            | Q5 defect-3 pin + the gone-id control                                                                                                           |
| RW7 | the release sentence names the installed version again       | `the shell's summary for a release names the reason the dispatcher was given`                                                                   |

Each of the three clauses of `installedByThisAttempt` has its own distinct
red, so none of them is decoration.

Suite: 170/170 green on `src/host/__tests__/update-run.test.ts`; compile clean.

One pin was corrected during the red-watch pass: `crashAtRestarting` leaves the
PRE-update host running in the mock world, which is not the field shape (the
`restarting` write happens after the cooperative stop, so the real wedge has no
host at all). The defect-1 pin and the gone-id control now set
`world.runningVersion = null` explicitly, and the defect-1 pin additionally
asserts the busy gate is never consulted - the `no-live-host` branch the real
box was on, which is a different arm from the `debt` branch an out-of-band host
would produce.

## DISPATCH: done. Committed.

Commit `9ddf128b9` on `traycer/q5-recovery-target-equal` (off `a05d40885`),
holding branch, NOT pushed. The pre-commit hook reformatted the three files, so
`q5-e6l-recovery.patch` and `snapshot/` are the PRE-format text — read the
commit, not the patch, when they differ by whitespace.

Sent: patch + addendum to reviewer B (3bb64ed2), touched-lines + Q10 handoff to
the CLI owner (ea8ce20c), evidence thanks to the Linux lane (e452ae67), cc to
the coordinator (d72a3c9b).

## Real-host evidence arrived (Linux lane, E6L) — all three defects confirmed

Wedge record: `phase: "restarting"`, `execution: "active"`,
`continuation: null`, `targetVersion: "1.4.3"`, claim baseline
`installedVersion: "1.4.2"` / `installGeneration: "id:4950d09a-0e37-40a6-a79a-13b2c01974dc"`.

The disk's `continuation: null` looks fatal to the fix and is not: the guard
reads `input.claim.record`, and `decideAttemptRecovery` (`transition.ts:435`)
recomputes `recoveryContinuation` → `activate` from hashed bytes before the
check site. **Reviewer B independently walked and CONFIRMED this chain.**

Matrix rows, before → after: `plain-no-version` and `--version 1.4.3` recover;
`--version 1.4.3 --intent continue --expect-attempt <id>` recovers (was exit 0,
record left at `restarting` forever — the lane watched it 90 s to rule out a
late async recovery). `--intent continue` with no `--version` still exits 1 —
that is defect 4, now **Q10, owned by ea8ce20c**, not mine.

Still outstanding from the lane: `wedged/bound-continue-with-version/install.json`,
to confirm the live install generation is the one the NEW swap wrote and not
the `id:4950d09a-…` the baseline still names. Needed for B's finding 1 below.

## REVIEWER B'S VERDICT: fix and analysis right; THREE follow-ups owed

### B1 (accepted, must act) — the rule DOES fire on a park; my docblock is wrong

I argued a park cannot reach `installedByThisAttempt` because a park's baseline
is refreshed AT the park and is therefore target-equal. B found the door:

1. `parkForActivation:2485` (sole `waiting-to-activate` writer, sole caller
   `:2413`) refreshes via `readClaimRefresh`.
2. `readClaimRefresh:2508` — when `readHostInstallRecord` returns **null** it
   returns `{ refresh: null }`, "carries the record's prior baseline unchanged".
3. `writer.park(phase, null)` (`:1191`) passes `claimRefresh: null`.
4. `refreshedClaimBaseline` (`transition.ts:1188`) returns `null` for a null
   refresh, retaining the prior baseline.

So a park whose install-record read transiently failed keeps its PRE-swap
baseline, and on the next resume all three clauses hold. Cost: the third
clause's protection becomes conditional on a refresh that can silently fail, so
the re-materialized-park hazard RW3 pins is reachable through a door no
ablation of `installedByThisAttempt` can redden. B would not block; it needs a
transient read failure at park time AND a foreign same-version install before
the resume.

**Two ways out; pick after the `install.json` lands.**
(a) Honest comment: rewrite the docblock's "unreachable" claim into a stated,
accepted narrow case. (b) Stronger: a FOURTH clause requiring
`baseline.installGeneration !== installGenerationOf(live)` — true on the real
E6L wedge, false for a re-materialized park. B says wait for the disk before
relying on (b). **The docblock is wrong either way and must change.**

### B2 (accepted, must act) — my holder argument is right, its support is not

"Lock acquisition precedes selection" does NOT exclude a live holder: the
mutation spans are taken and released per arm. What actually excludes it is
(i) the long-lived executor lock `withCliAttemptExecutor` in
`update-executor.ts`, held across the segment, and (ii) `decideAttemptRecovery`
independently refusing unless `holder.kind === "recovery-lock-held"`. Both in
files this patch does not touch. **Cite those two; the claim in the commit
message and in `interruptedResume`'s comment needs rewording.**

B also confirmed a `continue` on an interrupted `resume-apply` is not
over-authorization: the caller named that attempt by id, and applying is what
continuing it means.

### B3 (noted, one pin owed once both land) — cross-patch

Patch (B) dispatches a bound `activate` on a background tick. If the host stops
between the tick and the CLI run, that dispatch now exits 1 where it exited 0.
The park survives and is re-dispatched either way, so louder rather than
different — but a real cross-patch change deserving one row.

### B4 (handoff accepted, source not yet received)

REVIEW-B1: a bound `activate` on a `waiting-to-activate` park whose target is
already installed AND already running — `gate 0 / stop 0 / relaunch 0`,
`execution === "terminal"`, `phase === "superseded"`, trace
`["preparing", "superseded"]`. It belongs in MY file beside the
`activate resumes a waiting-to-activate park` row at `update-run.test.ts:1370`
(routing it through the 07 owner's branch would couple two lanes). **Ask B for
the source on wake.**

B's structural observation, worth carrying into Q9: every gap found across all
four patches this round has the same shape — the conjunct is local, its
authority is two files away, and no ablation of the local function can redden
it. Hence the coordinator's cross-package conjunct table requirement.

## Cross-patch interaction with the CLI owner's P2 (ea8ce20c) — DECISION PENDING

Their P2 routes EVERY selector release through `releaseAfterClosingStaleAttempt`,
which terminalizes an `execution: "active"` record and suffixes the ACK reason
`-stale-attempt-closed` (parks exempt, D-49). Consequences:

- **One of my pins reddens when both land**: `update-run.test.ts:4686` (the
  gone-id control) asserts a bare `refused-attempt-gone` AND `record.phase ===
"restarting"` afterwards. Mechanical to update — assert the suffixed reason.
- **But it is a rule change, not a pin update.** That pin's comment is the rule
  "a verb that named someone else's attempt may not reconcile this one". Under
  both patches a mistyped `--expect-attempt` TERMINALIZES a wedged bystander,
  while the correct id resumes it. Raised with B to decide once; proposed narrow
  option is to gate the stale close on the release not being id-bound. **If B
  rules "close regardless", update the pin and rewrite its comment.**
- Their reachability argument supersedes mine on the no-op release: both no-op
  arms are `install`-only because `startSelection` has exactly one caller and
  `selectBoundResume` never falls through to it. Cite theirs, not my exemption.
- Their P2 ALONE turns E6L from "wedged forever" into "closed, next run starts
  fresh" — looks fixed while discarding placed bytes. Reason not to revert my
  defect-2 hunk independently of their patch.

## Resume checklist for this branch

1. Ask the lane for `wedged/bound-continue-with-version/install.json`; decide
   B1 (a) vs (b).
2. Fix the `installedByThisAttempt` docblock (B1) and the holder-argument
   wording (B2). Commit.
3. Ask B for the REVIEW-B1 source; add it at `:1370`. Commit.
4. When B rules on the bystander question, update `:4686` accordingly.
5. Rebase/re-run all seven pins when ea8ce20c merges; they re-run 5 (Q6) + 7 (P2).

## B'S RULING on the bystander question (received just before the park)

**GATED. My pin `:4686` and its comment STAND — nothing to change on my side**
beyond the one comment line recording the ruling (done, in the commit below).

B's reasons, worth keeping because they are stronger than mine:

- #1773's justification is that the record is _unreferenced debris_. The record
  in my control pin is the opposite: a live recovery target with bytes already
  swapped, and exactly what a correct `--expect-attempt` would name and resume.
- Terminalizing on a release whose own reason is `refused-attempt-gone` ("I hold
  no authorization over what I found") contradicts the reason being reported.
- **The decisive one, and it is not the typo I framed it as**: the reconciler
  dispatches bound verbs automatically from an `attemptId` it read a tick
  earlier. If the record moves between that read and the CLI's lock
  acquisition - an ordinary race on a level-triggered loop - the id no longer
  matches, the bound release fires, and an automated actor destroys an attempt
  nobody named, on a timer.
- Gating costs nothing: unbound releases still close debris, which is #1773
  verbatim.

The gate B specified is `expectAttempt === null || expectAttempt === record.attemptId`
("you may close what you could have named"), NOT "not id-bound". The second
disjunct is dead today because my defect-2 hunk turns the id-matched active case
into a claim, but it states the real rule and survives a future bound release on
a matched id. **ea8ce20c implements it** and owns the unit-level twin pin in
`update-executor.test.ts`.

**Landing constraint B is giving the coordinator: P2 must not land without Q5**,
or the release ships a fix that silently discards recoverable state.

## Q9 orientation (next task, NOT started)

Stack on patch A = `traycer/q3-start-admission-parked`, head `ff4d2c9cf`
(2 commits over `a05d40885`; touches `contender.ts`, `host-start.ts`,
`contender.test.ts`, `index.ts`, `CONTENDER_INVENTORY.md`). dc84fa8b owns
`contender.ts` there and is doing a fixup first - coordinate before touching it,
no reverts.

The seam, read at `a05d40885` (patch A's changes NOT yet read):
`withUpdateContenderInternal` (`contender.ts:769`) computes `activeAttempt`,
then `:843` `if (activeAttempt !== null)` consults `dispositionFor(admission)`
(`:1002`), a pure switch on the admission constant alone -
`uninstall/service/desktop-activation/runtime-repair-maintenance` → `refuse`,
`legacy-update-shadow`/`stage-maintenance` → `yield`,
`recovery-maintenance`/`attempt-executor` → `allow`. It never reads holder
liveness, which is the coordinator's point 3 and mine: the supervisor is not
taking the update lock, so it cannot borrow the CLI's structural proof (and per
B2 that proof is the executor lock + `decideAttemptRecovery`'s
`holder.kind === "recovery-lock-held"`, neither of which the supervisor holds).

Q9 asks: which interrupted phases leave an install dir the host can safely run
from (ticket 03's swap seams - is the dir either fully old or fully new at every
kill point?), admit those with the record left for recovery and one INFO line,
refuse only where bytes can be inconsistent and say so. Pins per phase,
red-watched; cross-package conjunct table (predicate conjunct → authoritative
file → pin or citation) - B's structural observation says every gap this round
had a local conjunct with authority two files away.
