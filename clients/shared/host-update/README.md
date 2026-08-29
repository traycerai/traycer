# `@traycer-clients/shared/host-update` — durable update-attempt core

The on-disk transaction every host-update contender participates in. Implements
sections 0–2 of the host update progress technical plan: the schema-versioned
`update-attempt.json` record, the dedicated `update-attempt.lock` authority, the
legal-transition core, and the read-side interruption inputs.

**Nothing here executes an update.** No download, no stage promotion, no service
mutation, no restart. This layer decides _what a contender is allowed to do_ and
records _what it did_; the acting code lives in the CLI and the desktop.

## Lock order — `update-attempt.lock` is always outer to `cli-lock`

```text
acquire update-attempt.lock          ← coarse, whole execution segment
    acquire cli-lock                 ← short, one install-tree mutation
    release cli-lock
release update-attempt.lock
```

No actor may acquire them in the opposite order. `cli-lock` has holders that have
nothing to do with updating (`traycer host install`, uninstall, CLI self-upgrade),
so a process holding `cli-lock` while it waits for the attempt lock holds the
short lock for the duration of the coarse one — and two such processes deadlock
until a wait deadline expires. Coarse-outside-short removes the cycle by
construction. An adopter reading install evidence follows the same order: attempt
lock first, then `cli-lock` only for as long as it takes to re-read `install.json`
and the filesystem generation.

Across processes this is a property of the callers; the enforcement boundary is
the shared install-mutation / host-restart facades (contender-enforcement
ticket). Within one process, `acquireUpdateAttemptLock` refuses a re-entrant
acquisition with a distinct `held-in-process` outcome rather than letting a
caller wait on itself — Desktop genuinely runs several would-be contenders
(activation, pending revision repair, prefetch) in one process.

## Ordering is `attemptId + generation + sequence`. Never `updatedAt`.

| Field        | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `attemptId`  | The logical attempt. Minted once, by the executor that wins creation.                                         |
| `generation` | The execution **segment**. `create` = 1; every `resume`/`supersede` = +1. This is what rejects a late writer. |
| `sequence`   | The write counter. Monotonic across the whole attempt, never reset on a generation bump.                      |

Timestamps are display and staleness inputs only. `compareAttemptOrder` returns
`null` for two different attempts because they are genuinely incomparable —
inventing an order (by `startedAt`, say) is how a stale process talks itself into
overwriting a newer attempt. Supersession is an explicit, lock-held transition
for exactly that reason.

## Writing is a capability, not a convention

There is **no raw write or delete in the public surface.** The canonical resource
API starts from `hostHomeDir`: `acquireUpdateAttemptLock` derives and binds the
only legal pair, `update-attempt.lock` + `update-attempt.json`. No mutation API
accepts a lock or record path, so a sibling lock can never authorize canonical
record writes (or the canonical lock arbitrary sibling names).

`commitAttemptMutation` / `pruneTerminalAttemptRecord` take the issued handle —
an object only `acquireUpdateAttemptLock` can mint (membership in a module-private
`WeakSet`, so it cannot be forged by an object literal). A commit takes an
explicit legal intent (`create`, `resume`, `advance`, or the first `supersede`
write), not a caller-shaped next record. Under the handle it re-reads canonical
state and recomputes that exact next record through the pure transition algebra.
Before touching anything, it:

1. verify the handle is genuine, **unreleased**, and still owns the lock token
   **on disk** (a handle outlives its lock when another contender breaks it);
2. re-read canonical state from disk, never trusting the caller's copy;
3. derive the precise legal record from the requested intent (`create`,
   `resume`, `advance`, `supersede`, or lock-scoped `recover`), including exact
   identity, target, trigger, generation, sequence, phase, and continuation;
4. re-verify ownership immediately before the write.

Each handle also has a synchronous per-handle mutation lease. `release()` first
stops new leases and waits for any admitted commit/prune to reach its rename or
unlink before removing the on-disk lock. A releasing handle can therefore never
hand authority to a new contender while an old mutation is still in flight.

Terminal evidence is pruned only after the fixed
`TERMINAL_ATTEMPT_RETENTION_MS` policy (seven days). The public prune request
supplies `nowMs` for its observation point, never a caller-selected retention
window, so a maintenance caller cannot erase diagnostics early.

The identity checks inside `advanceAttempt` do not substitute for this: they
compare two objects the caller supplied. A callback that runs after its segment
released the lock would otherwise overwrite generation N+1 with its cached
generation N, or delete a live attempt outright. The check has to happen at the
point of the write, against disk, under a proven-live claim.

Reads stay total and lock-free — a status projection must read without
contending and must never be able to write.

A parent-directory sync failure that is not a _positively known_ unsupported
**fsync-stage** case yields `durability-unverified`, not success: directory-open
and permission errors (`EACCES`/`EPERM`) are never treated as support evidence.
The bytes are probably in place but the guarantee is missing, so the caller must
re-read canonical state and start no side effect.

## The five actions

`decideAttemptClaim` returns exactly one, per plan §1.1:

| Decision    | When                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `create`    | No record, or a retained terminal one. Holder only, only for unbound `start`, and requires a fresh id. |
| `attach`    | Same-target **active** work with positive evidence of another live holder.                             |
| `resume`    | Holder, exact identity/target/action, record **parked**. Lands in `preparing` — see below.             |
| `supersede` | Holder, different target, record **parked**. Terminalizes, then decide again.                          |
| `refuse`    | Anything it does not own, with the reason attached.                                                    |

Two orderings inside that table are load-bearing:

- **An identity-bound request (`expected !== null`) is resolved first, before
  any create path.** A Force/Activate/Defer request names an attempt that was
  live when it was authorized; if that attempt is absent or already terminal the
  request has nothing to act on, and the one thing it must not do is mint a
  fresh attempt from its own `targetVersion` and `initialPhase` — a delayed
  request replaying as a brand-new update days later. Absent → `stale-expectation`;
  matching but terminal → `attempt-already-terminal`.
- **Request authorization is a tuple.** Besides `attemptId + generation +
sequence`, `AttemptClaimRequest` carries `targetVersion` and an explicit
  action: `start`, `resume-apply`, `activate`, `force`, or `defer`. A matching
  identity for a different target fails; `resume-apply`/`force` can only resume
  `waiting-for-work`, `activate` only `waiting-to-activate`, and `defer` is not
  a claim action. The core cannot turn an old request into a different segment.
- **`requires-recovery` outranks supersession, for every active record.** An
  executor that died after promoting the install tree but before its write-after
  record leaves a record still reading `applying`. Letting a different-target
  request terminalize it would mint a fresh attempt with no reconciliation of
  `install.json`, staged artifacts, or the filesystem generation. The recovery
  layer may still decide to supersede; it may not be skipped on the way there.

`resume` lands in `preparing` for both continuations and never in the phase that
does the work: `resume-apply` must re-verify stage evidence before `applying` is
committed, and `activate` must run the final drain/force check _before_
`restarting` is written, because no deferrable gate may exist after that phase.

## A continuation is born at a park and dies at a terminal

`advanceAttempt` moves an attempt **within** a segment and requires
`current.execution === "active"`. Leaving a park is an adoption, not an advance:
it bumps `generation` and must pass the expected-identity check. Allowing
`waiting-to-activate → restarting` here would let a holder walk out of a park
with no generation bump at all, silently disarming the check that rejects a
stale Force/Activate request.

While a continuation is in flight it is carried unchanged, except for one
durable handoff that proves byte placement:

| Target phase | Required continuation                                      |
| ------------ | ---------------------------------------------------------- |
| terminal     | `null`                                                     |
| parked       | that park's own, and the same one already in flight if any |
| active       | exactly what is already in flight — no erase, no swap      |

`resume-apply` may become `activate` only on
`applying → waiting-to-activate`: the `applying` record is the write-ahead fact
that packaged-Mac bytes were placed. No `preparing` state (plain or resumed)
may manufacture that park. Until a resumed `resume-apply` segment has written
`applying`, it cannot restart, verify, or enter activation. Conversely,
`activate` follows final preparation/drain → restarting → verifying; it may
re-park at `waiting-to-activate` if the drain defers, but it cannot download,
apply, or verify directly from preparation.

## Fail closed, always

A corrupt, unreadable, or unsupported-version record is never silently replaced
by a new attempt. `decodeHostUpdateAttempt` is total over raw bytes and returns
each of those as a distinct arm; `decideAttemptClaim` maps all of them to
`refuse: "record-fail-closed"`, and `deriveAttemptLiveness` maps them to
`indeterminate`. Repair is a deliberate, separate action.

The same rule governs interruption. `interrupted` requires **all** of: a valid
record, `execution === "active"`, a stale `updatedAt`, and _positive_ proof that
no holder exists. A probe failure, an unparseable lock file (which a holder still
inside `open()`→`writeFile()` also produces), a future-dated stamp, or a park of
any age all resolve to something else.

`probeAttemptHolder` caches its liveness verdict per lock path, fingerprinted on
the holder's own identity so it expires on content change as well as on time.
Without that, fleet status polling would spawn `tasklist` per host per read on
Windows.

Two decode rules exist to keep mixed-version and partial-write detection honest:

- **Counters must be _safe_ integers.** At `2^53`, `+ 1` returns the same number,
  so a counter past the safe range makes "the sequence advanced" unenforceable
  and lets a late writer compare equal to the write that superseded it. Every
  bump goes through `nextAttemptCounter`, which refuses at the ceiling rather
  than returning a no-op increment.
- **`continuation`, `progress`, `completedAt`, and `error` must be present**,
  with explicit `null` for absence. Normalizing a missing key to `null` let a
  writer claim `schemaVersion: 2` while emitting an arbitrary subset of the
  contract, and made a partially-written record indistinguishable from a
  complete one.

## Symlinks are refused at `open`, not before it

`readUpdateAttemptRecord` opens with `O_NOFOLLOW | O_NONBLOCK` and validates the
opened **handle** with `fstat`. A symlink swap cannot be followed
(`ELOOP`/`EMLINK` → `unreadable`), and a FIFO/device/socket is classified as
non-regular without waiting for a writer. Windows has no `O_NOFOLLOW`: its
fallback admits an opened descriptor only when pre-open and opened identity are
both positive and equal. Zero inode/device identity, a reparse point, or any
unprovable swap fails closed as `unreadable`; it never trades the race for a
permissive read. `__setBeforeRecordOpenHookForTest` exists so the swap-at-open
case can be exercised deterministically.

## Recovery and still-deferred work

- **Executor recovery.** An active, unheld record still resolves to
  `refuse: "requires-recovery"` from ordinary claim algebra. The executor is
  the only actor allowed to answer that refusal: while it holds the canonical
  capability it gathers typed install/stage evidence with placed-byte generation
  fingerprints and an authenticated healthy-host proof bound to the canonical
  PID record. It collects that proof again immediately before the recover
  write; a changed fingerprint is an ambiguity, not a conclusion. Exact
  installed bytes plus an exact host-home-bound running target may terminalize
  `complete`; installed but not restarted bytes resume `activate` from
  `preparing`; a verified stage resumes `resume-apply`; contradictions
  terminalize `failed`; a newer desired target uses the existing
  terminalize-then-create supersede sequence. The original request action still
  authorizes the resulting continuation: recovery cannot turn Defer into Apply
  or Resume/Force into activation. Terminal recovery carries an evidence summary
  and `recoveredBy` provenance.
- **Cohort selection.** The CLI executor cohort is deliberately shadow-only in
  this release. No legacy command, marker, or existing executor selects it;
  Ticket 07 owns compatibility cutover after the fleet fence passes.
- **Cutover.** The legacy `update-progress.json` marker is untouched and remains
  authoritative. Nothing in this directory is wired into the current update
  command.
- **Host-side reuse.** `traycer-host` cannot import `@traycer-clients/shared`.
  When the host status projection needs to read this record, the pure contract
  (record type, decoder, path helpers) should move to
  `@traycer/protocol/config`, following the `host-stop-intent` precedent — a
  second decoder for one file is how the shapes drift apart.
