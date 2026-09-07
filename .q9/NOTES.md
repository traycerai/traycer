# Q9 — a supervisor may finish the restart an interrupted attempt promised

Owner: a08004f6. Branch `traycer/q9-supervisor-active-admit`, stacked on patch
A's `bafc226ec` (`traycer/q3-start-admission-parked`). Not pushed.

HOLDING-BRANCH ARTIFACT: `.q9/` must be dropped before this reaches anything
shared.

## Commits

SHAs were REWRITTEN once, to narrow the lead commit's message from "fixes
E6L" to "fixes the reboot / manual start path" (see the Linux-lane finding
below). Anything citing the old shas `45b489909` / `0db667743` / `038b782ed` /
`8707a3853` is reading the pre-reword branch.

| SHA         | What                                                              |
| ----------- | ----------------------------------------------------------------- |
| `e40c0b52a` | the admission change (`contender.ts`, `host-start.ts`, pins)      |
| `96a131ffd` | the INFO line, routed through `onAdmittedBeside`                  |
| `b17e55132` | moved a pin that was watching nothing                             |
| `368a07a30` | pinned the field-observed `restarting`/`continuation: null` shape |
| `5b59ce157` | this note                                                         |
| `42e67dfa8` | cold review B's dependency pin + the corrected conjunct rows      |

Suites: `shared` contender 89/89, CLI `host-start` + `host-start-adoption`
107/107, `tsgo --noEmit` clean.

## The change

A CLI killed after its swap leaves `restarting` / `execution: "active"`, the
host stopped for that swap. The supervisor refused, exited 0, and no service
manager relaunches on a zero exit — box down, with the reconciler that would
resume the record living inside the host that is not running. Linux E6L.

**Criterion: idempotence, not whole bytes.** "Is the install directory a
complete tree of a known version" is necessary and not sufficient — a LIVE
`applying` segment between lock spans may have finished its swap and be about
to restart the host itself. A supervisor cannot prove the holder absent
(`decideAttemptRecovery`'s `holder-not-proven-absent` is exactly that), so the
question is: **if the holder is alive and resumes, does this supervisor having
started the host change the outcome?**

ADMIT `restarting`, `verifying`, and `preparing` + `continuation: "activate"`
— the shapes whose own next act IS starting the host — each requiring
`installed.installedVersion === record.targetVersion`.

REFUSE `applying` (moves bytes; a host started from a directory the swap is
about to rename is not a recovery) and the pre-placement shapes `downloading`,
`preparing` + `null`, `preparing` + `resume-apply` (their next act is to STOP
the host and swap, so a start can turn an update that would have applied into
one that parks — benign, but a changed outcome).

Removed `if (record.execution !== "parked") return "refuse"` rather than
carving into it: dead by the decoder, but it would have blocked this arm.

## Cross-package conjunct table

| Conjunct                                                                              | Authority                                                                                                                                                                                            | Watched by                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restarting`/`verifying` ⇒ the target's bytes are placed, for a `resume-apply` record | `continuationPhaseOrderRejected`, `shared/host-update/transition.ts:1223`                                                                                                                            | **pinned in-package, behaviourally**: the "Q9 dependency" row in `contender.test.ts`; red-watched by deleting the `resume-apply` arm                                                                                                                                             |
| ...the same, for a `null`-continuation record                                         | the three `restarting` writers in `cli/host/update-run.ts` (`:1838`, `:2259`, `:2402`) — the core does NOT forbid `preparing`+`null` → `restarting`                                                  | **cross-package citation.** The live `installedVersion === targetVersion` read is what actually protects this case                                                                                                                                                               |
| `preparing` + `activate` is the recovery-resume shape                                 | `resumedRecord` / `recoveryContinuation`, `transition.ts`                                                                                                                                            | citation; the production path is exercised by the Q5 pins in `cli/host/__tests__/update-run.test.ts`                                                                                                                                                                             |
| the decoder derives `execution` from `phase`, so the removed line was dead            | `executionForPhase`, `@traycer/protocol/config/host-update-attempt`                                                                                                                                  | **pinned**: `shared/host-update/__tests__/decode.test.ts:226`; independently ablated (deleting the line left 82/82 green)                                                                                                                                                        |
| `installed === null` is also the swap's absent window                                 | `atomicSwap`'s two renames, `cli/installer/install.ts`                                                                                                                                               | citation + the absent-window pin (RW-Q5)                                                                                                                                                                                                                                         |
| the claim baseline is STALE post-swap, so no generation test here                     | `applying → restarting` passes `claimRefresh: null`, `cli/host/update-run.ts`                                                                                                                        | the generation-drift pin (RW-Q6)                                                                                                                                                                                                                                                 |
| the install-generation string is byte-comparable across producers                     | `encodeInstallGeneration`, `shared/host-version/install-generation.ts`                                                                                                                               | pinned by dc84fa8b across five callers in `install-generation.test.ts`                                                                                                                                                                                                           |
| no LIVE executor segment exists when this arm runs                                    | the attempt lock: `withCliAttemptExecutorCompletion` wraps `execute` (`cli/host/update-executor.ts:472`) so a live segment holds it for its whole span, and the supervisor contends with `waitMs: 0` | **structural, not a probe.** `withUpdateContenderInternal` returns `busy` before any disposition is consulted. A `probeAttemptHolder` call inside `dispositionFor` would observe THIS contender and report `holder-live`, refusing everything while looking like a safety check. |
| `{restarting, verifying}` equals `POST_TOMBSTONE_PHASES`                              | `shared/host-update/compatibility-fence.ts`                                                                                                                                                          | **deliberately NOT shared.** Same membership, opposite polarity (there: cannot walk back to a park, must terminalize). Named as a coincidence, not aliased.                                                                                                                      |

## Red-watches (all run; restored via `git checkout` on COMMITTED files)

| #     | Ablation                                                  | Reddened                                                                                                                      |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| RW-Q1 | `restarting`/`verifying` dropped from the placed set      | both admit rows + the three restarting-specific refusal pins (they assert `readerCalls === 1`, so they cannot pass vacuously) |
| RW-Q2 | `preparing` + `activate` dropped                          | the `preparing-activate` admit row ALONE                                                                                      |
| RW-Q3 | the placed-set gate removed (blanket admit)               | all five refusal rows                                                                                                         |
| RW-Q4 | target-version equality dropped                           | the "install is NOT the target" pin alone                                                                                     |
| RW-Q5 | `installed === null` admitted                             | the absent-window pin alone                                                                                                   |
| RW-Q6 | the parked arm's claim/generation test applied here too   | the generation-drift pin alone                                                                                                |
| RW-Q7 | the announcement call site removed                        | the announcement pin                                                                                                          |
| RW-Q8 | the default dep announces with no record standing         | the canonical-admission adoption pin                                                                                          |
| RW-Q9 | the restarting arm keyed on `continuation === "activate"` | both null-continuation field-shape rows                                                                                       |

## Two process notes worth keeping

- **RW-Q8 initially did not redden.** The counter had been added to both direct
  callers of `admitHostStartSpawn`, and in the adoption-GRANT test it watched
  nothing — that path returns before the contender runs. Moved to the
  canonical-admission test, which reaches it. A pin that looks like protection
  and catches nothing is the exact failure mode this round has been finding.
- **I destroyed uncommitted work with `git checkout` during a red-watch.** The
  `onAdmittedBeside` refactor was not yet committed when I restored
  `host-start.ts`. Rebuilt from context; nothing lost permanently. Rule
  restated: red-watch only COMMITTED files, or snapshot first.

## Owed

- Reviewer B (3bb64ed2): the design + this table sent; awaiting review.
- dc84fa8b owns `contender.ts` on patch A — told them what I touched. They owe
  a whitespace nit in the docblock and offered a cross-reference sentence about
  `readClaimRefresh` failing OPEN on my Q5 side and CLOSED on theirs.
- Linux lane (e452ae67) is building a reboot / `host start` wedge over an
  interrupted-active record. **That evidence can still move this**: my brief
  assumed the supervisor refuses and wedges E6L, but the lane's sweep found
  zero refusals against non-parked records — silence, because nothing invokes
  the supervisor after a cooperative stop. If the reboot row shows the
  supervisor is never asked, then this change fixes the reboot case and E6L's
  immediate outage is fixed by the Q5 patch alone. Both are worth having; the
  claim in the commit message about which one E6L needed may need narrowing.
