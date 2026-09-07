# Q12 — record the generation the swap itself wrote

Owner: a08004f6. Branch `traycer/q12-swap-generation`, stacked on the Q13 tip
(`3306e3330`). Not pushed. **HOLDING-BRANCH ARTIFACT: `.q12/` must be dropped
before this reaches anything shared.**

## The brief was wrong in three places, and the corrections shrank the ticket

| Brief said | Actually |
| --- | --- |
| protocol key on my branch | **no protocol change.** `AttemptAdvance.claimRefresh` already exists (`transition.ts:1048`) and `advanceAttempt` already applies it (`:1150`). The machinery is advance-generic, never park-specific |
| dc84fa8b told | nothing to tell them — no protocol file touched, no `contender.ts` |
| older-decoder tolerance pinned | nothing new is decoded, so there is nothing to tolerate |

The whole defect was one hard-coded `null`: `phaseWrite` passed
`claimRefresh: null` unconditionally, so `applying → restarting` — the single
advance that crosses a change of installed bytes — carried a baseline its own
swap had just falsified.

## Commits

| SHA | What |
| --- | --- |
| `b1719506e` | `phaseWrite(phase, claimRefresh)` required; the swap sites refresh; claimless pinned |
| `a54dbed81` | the activation arm carries rather than refreshes; the downgrade swap pinned |

## The design

`phaseWrite`'s second parameter is **required**, not defaulted — AGENTS.md bans
optional params, and here that ban pays: six of the nine call sites pass `null`,
and each is now a stated decision rather than an inherited one.

Only **two** arms actually swap:

| Arm | Site | Refreshes? |
| --- | --- | --- |
| `applyArm` | `:1857` | yes — the primary path |
| `downgradeArm` | `:2282` | yes |
| `activationArm` | `:2429` | **no — carries** |

## The finding that changed the code, not just a test

I first refreshed at all three `restarting` writers. Then I ablated each one
**individually** rather than all together:

| Ablation | Result |
| --- | --- |
| null the `applyArm` site alone | 1 red |
| null the `downgradeArm` site alone | **163 green** |
| null the `activationArm` site alone | **163 green** |

Two thirds of the production change had nothing watching it. Following that up
found a genuine error rather than a missing test: **the activation arm does not
swap.** It stops the host and relaunches it onto bytes an earlier segment
placed, so asking it for "the generation the swap wrote" was a lie about where
the value came from. Both births of an `activate` continuation already refresh
the baseline — the busy park via `parkForActivation`, and the recovery resume
via its own park — so carrying preserves that work instead of re-reading the
same record to restate it. Reverted to `null`, which removes an unpinnable site
rather than leaving dead defensive code.

The `downgradeArm` genuinely swaps and is now pinned, on the sharpest available
case: the claim is taken against 2.0.0, the swap installs 1.0.0, and the two
cannot be confused for one another by accident.

## What Q12 does NOT do — and it lands on Q17

`refreshedClaimBaseline` **ignores a refresh on a record carrying no claim**,
deliberately: *"a legacy continuation cannot gain an authorization nobody ever
granted it."* So a claim-less attempt gets **no** recorded generation from its
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
(*"the mitigation is not local — it is recording the generation the swap itself
wrote"*), but a pre-Q12 record still has nothing to compare, so the comparison
cannot become unconditional. **That docblock needs updating and I did not touch
it**: dc84fa8b is holding `contender.ts` for comment work, and editing the same
docblock concurrently is exactly what we agreed to avoid. Told them instead.

## An acceptance pin changed meaning, and the change is the deliverable

`update-run.test.ts:4549` used to assert a crash at `restarting` left a claim
naming the **pre-apply** install, commented *"only the refresh the recovery
park writes makes them equal"*. That was the defect written down as a property.
The baseline is now already at the target when the crash happens; the recovery
park's own refresh (`:4563`) still passes, so it is no longer the only source.

## Red-watches

| # | Ablation | Reddened |
| --- | --- | --- |
| RW-12a | all three `restarting` writers nulled | 1 (which is how the gap was found) |
| RW-12a′ | each site nulled ALONE | applyArm 1 red; the other two green → the finding |
| RW-12b | claimless records gain a minted claim | both claimless pins |
| RW-12c | consent restated instead of copied | 2 shared + 2 CLI, including my new downgrade pin |
| RW-12d | `applyArm` site alone, after the fix | 1 red |
| RW-12e | `downgradeArm` site alone, after the fix | 1 red |

## Suites

`transition` 125/125, `update-run` 164/164, `contender` 90/90, `tsgo` clean.

## Owed

- Tell dc84fa8b the `supervisorRelaunchOverActive` docblock now needs its
  "until that exists" sentence updated — Q12 exists.
- The detective half of the compatibility fence, queued next.
