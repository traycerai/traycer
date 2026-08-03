import type { ConnectionManifest } from "@traycer/protocol/framework/index";

/**
 * One historically-released, still-supported app/host version's frozen
 * `/stream` `ConnectionManifest` - the per-method `{ major, minor }`
 * canonical it advertised at that version - plus a human-readable label.
 *
 * The streaming counterpart of `support-matrix.ts` (unary `/rpc`).
 * Complementary to `released-stream-method-names.ts` (which freezes only
 * the method-NAME set for the same `host-v1.0.0` baseline): this captures
 * the full per-method version so `two-sided-stream-release-invariant.test.ts`
 * can run `checkStreamCompatibility()` against the CURRENT live
 * `hostStreamRpcRegistry`, not just diff name sets.
 */
export type StreamSupportMatrixEntry = {
  readonly version: string;
  readonly manifest: ConnectionManifest;
};

/**
 * AUTO-GENERATED entries come from
 * `protocol/scripts/snapshot-stream-support-matrix.ts`. Do not hand-edit an
 * entry's `manifest` - regenerate it instead.
 *
 * ## Appending a new version at release-cut time
 *
 * 1. On the commit/tag being released, run:
 *      bun run protocol/scripts/snapshot-stream-support-matrix.ts <version-label>
 *    e.g. `host-v1.2.0` (match the tag naming already used for the unary
 *    `support-matrix.ts`).
 * 2. Paste the printed entry as a NEW element appended to the array below.
 *    Never edit or reorder existing entries in the same change - append only.
 * 3. Only DROP an entry when a coordinated release deliberately ends support
 *    for that version. The diff that removes it is the reviewable record.
 *
 * ## Why only `host-v1.0.0` is seeded today
 *
 * `host-v1.0.0` is the oldest still-supported floor - the exact baseline
 * `released-stream-method-names.ts` already freezes the method-name set
 * against, and the same commit the unary `support-matrix.ts` anchors to
 * (`fd65a24`, PR #84). This manifest was captured from that same commit's
 * `hostStreamRpcRegistry` via a temporary detached `git worktree` checkout
 * (`git worktree add --detach <tmp> fd65a24`, `bun install`, run a throwaway
 * dump script against `buildStreamManifest(hostStreamRpcRegistry)`, then
 * `git worktree remove` - no residue left in the working tree). At that
 * commit every stream method was still at its `1.0` baseline.
 *
 * The CURRENT dev-tip registry has NOT drifted from this baseline's method
 * NAMES (verified: `Object.keys(hostStreamRpcRegistry)` today is the exact
 * same 9-name set as below) - only per-method versions have moved forward
 * additively (`terminal.subscribe` -> 1.2, `chat.subscribe` -> 1.1, both via
 * proper version bumps, not new names). So this test currently has nothing
 * to catch yet, which is the correct, honest state - it exists as a
 * forward-looking guard for the day a stream method version bump silently
 * drops a bridge, matching the unary invariant's coverage.
 *
 * The CURRENT dev-tip registry itself is intentionally NOT a frozen entry
 * here - `two-sided-stream-release-invariant.test.ts` reads
 * `hostStreamRpcRegistry` live and checks it against every entry below, so
 * the "current" side of the matrix is always up to date by construction.
 */
export const streamSupportMatrix: readonly StreamSupportMatrixEntry[] = [
  {
    version: "host-v1.0.0",
    manifest: {
      "agent.inbox.subscribe": { major: 1, minor: 0 },
      "chat.subscribe": { major: 1, minor: 0 },
      "epic.subscribe": { major: 1, minor: 0 },
      "git.subscribeStatus": { major: 1, minor: 0 },
      "migration.run": { major: 1, minor: 0 },
      "notifications.subscribe": { major: 1, minor: 0 },
      "speech.dictate": { major: 1, minor: 0 },
      "terminal.subscribe": { major: 1, minor: 0 },
      "worktree.deleteByPath": { major: 1, minor: 0 },
    },
  },
];
