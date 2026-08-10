# Two-sided release invariant

Architecture decision #15 / R4-D2:

> Every supported app version can open a session to every host >= the
> version floor; floor raises are constrained by the support matrix; a new
> capability must ride a versioned `{ major, minor }` bump of an EXISTING
> method, never a new method name.

This decomposes into two checkable properties, both enforced as tests over
`@traycer/protocol`, not runtime code:

1. **Name-set stability** - `protocol/src/host/__tests__/released-surface-compat.test.ts`.
   Freezes `Object.keys(hostRpcRegistry)` against the `host-v1.0.0` baseline
   (`__fixtures__/released-method-names.ts`). Catches a brand-new method name
   being added instead of a version bump on an existing one, or a method a
   supported peer still relies on being removed.
2. **Cross-version bridging** - `protocol/src/host/__tests__/two-sided-release-invariant.test.ts`
   (this file's sibling). Given the support matrix of still-supported
   historical manifests (`__fixtures__/support-matrix.ts`), runs
   `compatibility-checker.check()` between the CURRENT live `hostRpcRegistry`
   and every historical entry, in both directions. Catches a version bump
   that silently drops a bridge a still-supported peer needs (e.g. a deleted
   `upgradeFromPreviousVersion` or `downgradePathsFromLatest` entry) - the
   thing a name-set-only diff cannot see, because the name sets can match
   exactly while the per-method versions still fail to bridge.

Both are release-engineering guards, not production code paths: they run in
CI against the source tree, not inside the host or client at connection
time.

## The `/stream` handshake has the SAME guard, in parallel

The `/rpc` unary handshake and the `/stream` handshake are two DIFFERENT
compat-negotiated surfaces (`hostRpcRegistry` vs `hostStreamRpcRegistry`,
`compatibility-checker.check()` vs `stream-compat.ts`'s
`checkStreamCompatibility()`). Both are fail-closed on the same method-NAME
union semantics - a name present on only one peer is fatal for the WHOLE
connection - so both need the same two-part guard. Until this was added, only
the unary side had it: a brand-new `/stream` method name could have shipped
without ever tripping a name-set freeze.

1. **Name-set stability (stream)** -
   `protocol/src/host/__tests__/released-stream-surface-compat.test.ts`,
   frozen against `__fixtures__/released-stream-method-names.ts`
   (regenerate via `protocol/scripts/snapshot-released-stream-method-names.ts`).
2. **Cross-version bridging (stream)** -
   `protocol/src/host/__tests__/two-sided-stream-release-invariant.test.ts`,
   against `__fixtures__/stream-support-matrix.ts` (regenerate a new entry
   via `protocol/scripts/snapshot-stream-support-matrix.ts <version-label>`).

Both stream fixtures are seeded from the exact same `fd65a24` baseline commit
as the unary ones (captured via a temporary detached `git worktree` checkout,
never mutating the working tree in place) - `host-v1.0.0`'s
`hostStreamRpcRegistry` had 9 methods, all at `1.0`. As of this writing the
CURRENT registry has the exact same 9 method names (only additive minor
bumps since - `terminal.subscribe` -> 1.2, `chat.subscribe` -> 1.1) - so
both new stream tests are honestly green today, not forced green. They exist
as the forward-looking guard for the day a stream method's name OR version
bump would otherwise silently break the `/stream` handshake, exactly
mirroring the unary coverage.

One real semantic difference to know when reading these tests:
`checkStreamCompatibility` has no cross-major downgrade bridge (v1 stream
clients reconnect on a mismatched major rather than bridging, unlike the
unary side's `downgradePathsFromLatest`) - so a future stream major bump
correctly reports incompatible in this matrix rather than silently passing;
that is intended v1 behaviour, not a bug for this test to paper over.

## Appending a new version to the support matrix

At the point a new host/app version is cut for release:

```bash
bun run protocol/scripts/snapshot-support-matrix.ts host-v1.2.0
```

This prints one `SupportMatrixEntry` object literal (the full per-method
`{ major, minor }` manifest for every method in the live registry, tagged
with the label you passed). Paste it as a new element appended to the
`supportMatrix` array in
`protocol/src/host/__tests__/__fixtures__/support-matrix.ts` - append only,
never edit or reorder existing entries in the same change. The fixture file's
own header has the full procedure and explains why only `host-v1.0.0` is
seeded today (it's the same baseline `released-method-names.ts` already
freezes, captured from the exact commit - `fd65a24`, PR #84 - that produced
that fixture).

Only ever DROP an entry from the matrix when a coordinated release
deliberately ends support for that version; the diff that removes it is the
reviewable record of that decision, exactly like regenerating
`released-method-names.ts`.

The same procedure applies to the `/stream` matrix, one flag different:

```bash
bun run protocol/scripts/snapshot-stream-support-matrix.ts host-v1.2.0
```

Paste the result into `streamSupportMatrix` in
`__fixtures__/stream-support-matrix.ts`. Cut both the unary and stream
entries for a given release in the SAME change - they describe the same
released registry state, so letting one drift ahead of the other reintroduces
exactly the blind spot this whole guard exists to close.

## Wiring into the release pipeline

Release/tagging logic lives in the **outer** (private) repo, not in this
open-source `traycer/` submodule - this submodule's own CI
(`traycer/.github/workflows/test.yml`) just runs `nx test` across packages,
which already picks up both guard tests above on every push/PR since they're
ordinary `vitest` specs under `protocol/src/host/__tests__/`. No extra wiring
is needed for them to run as part of normal CI.

What genuinely needs a human to wire it in is making this a **release-cut
gate** in the outer repo's release workflows, so a coordinated release cannot
tag/publish a host build that fails the two-sided invariant against the
support matrix:

- `.github/workflows/release-host.yml` - add a step that runs
  `bun run --filter @traycer/protocol test -- two-sided-release-invariant`
  AND `-- two-sided-stream-release-invariant` (or the equivalent `vitest run`
  invocation scoped to both spec files - unary and stream are complementary,
  neither substitutes for the other) as a **pre-tag gate**, positioned before
  the signed host build/publish step. A failure here should block the
  release the same way a failed `released-surface-compat` /
  `released-stream-surface-compat` run already implicitly would if it's part
  of the same `nx test` gate.
- `.github/workflows/release-cli.yml` - same gate (both unary and stream),
  same reasoning, since the CLI inlines `@traycer/protocol` at build time and
  is the other side of this handshake.
- If `release.yml` (the dispatcher that derives `RELEASE_REPO` tags and fans
  out to the host/CLI/desktop release workflows) has a single shared
  "verify" or "test" job that all three release workflows depend on, that
  shared job is the single best place to add this gate once, rather than
  duplicating it into each of `release-host.yml` and `release-cli.yml`
  separately - whichever is true of the outer repo's actual structure at the
  time this is wired in.

This document only describes where the gate should go; the outer repo's
workflow YAML is out of scope for this submodule and is not edited here.
