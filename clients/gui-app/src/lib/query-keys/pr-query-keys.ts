/**
 * Query key builders for the `pr.*` host stream surface.
 * Scope: `pr-panel-and-list-hook` ticket (Epic PR View T5).
 */

import { hostQueryKeys } from "./host-query-keys";

/**
 * The identity every local-diff key variant shares below the host scope.
 *
 * `repoRole` is in it because the request carries it and the host RESOLVES by
 * it: the same `(linkGroupKey, owner/repo)` pair names the superproject root
 * under one role and an owned-submodule checkout under the other, so a role
 * change across detail frames must be a different cache slot, not a stale
 * reuse of the other checkout's answer.
 */
interface PrLocalDiffKeyIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly linkGroupKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoRole: string;
}

/**
 * Key PREFIX for every `pr.getLocalFileDiff` entry belonging to one PR's
 * checkout, exported for INVALIDATION: the tile's manual refresh and its
 * range-drift recovery both need "clear every per-file answer under this
 * checkout" without knowing which OID pairs are cached. `localFileDiff`
 * composes on top of this, so the prefix relation is structural rather than
 * a copy that could drift.
 */
function localFileDiffScope(args: PrLocalDiffKeyIdentity) {
  return [
    ...hostQueryKeys.scope(args.hostId),
    "pr",
    "localFileDiff",
    args.epicId,
    args.linkGroupKey,
    args.owner,
    args.repo,
    args.repoRole,
  ] as const;
}

export const prQueryKeys = {
  /**
   * Query key for the epic-scoped PR list cache
   * (`pr.subscribeListForEpic`). Scoped by `(hostId, epicId)` only - NOT by
   * `mode`: a background and a foreground subscription for the same epic
   * feed the same cache entry (the host runs one poller per
   * `(hostId, epicId)` regardless of how many modes are subscribed).
   *
   * Named args like its two siblings: positionally, `hostId` and `epicId` are
   * two adjacent strings, and swapping them builds a valid-looking key for the
   * wrong scope that nothing downstream can catch.
   */
  listForEpic: (args: {
    readonly hostId: string | null;
    readonly epicId: string;
  }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "listForEpic",
      args.epicId,
    ] as const,

  /**
   * Query key for one PR's projected detail cache (`pr.subscribeDetail`).
   * Scoped by `(hostId, epicId, githubHost, owner, repo, prNumber)`. The heavy
   * FACTS are host-global (the host persists one row per PR), but the projected
   * FRAME is epic-flavored: the host stamps each frame with the subscribing
   * epic's `owners`, `repoIdentifier`, and merge-provenance fallback. Two epics
   * viewing the same PR run separate epic-scoped sessions; omitting `epicId`
   * here would collapse them onto one cache entry and let each epic's frame
   * clobber the other's owners. Scope by `epicId` so the frame projections stay
   * isolated per epic.
   */
  detail: (args: {
    readonly hostId: string;
    readonly epicId: string;
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "detail",
      args.epicId,
      args.githubHost,
      args.owner,
      args.repo,
      args.prNumber,
    ] as const,

  /**
   * Query key for one PR's LOCAL diff (`pr.getLocalDiff`).
   *
   * Keyed by the range, not by the PR: `headRefOid` is in the key so a new
   * push re-fetches on its own the moment the detail stream reports the new
   * tip, and `linkGroupKey` is in it because the same PR reached through two
   * bindings is two different checkouts with two possibly different answers.
   * `epicId` IS part of the key. A range diff of two commits is the same diff
   * whoever asked, but the ANSWER is not: the host gates `pr.getLocalDiff` on
   * the caller's role in `epicId` and only honours a binding belonging to that
   * epic, so the identical PR under a different epic can legitimately come
   * back `unavailable`. Sharing one slot would let one epic's answer be served
   * for another.
   */
  localDiff: (
    args: PrLocalDiffKeyIdentity & {
      readonly baseRefName: string;
      readonly headRefName: string;
      readonly headRefOid: string | null;
      readonly ignoreWhitespace: boolean;
    },
  ) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "localDiff",
      args.epicId,
      args.linkGroupKey,
      args.owner,
      args.repo,
      args.repoRole,
      args.baseRefName,
      args.headRefName,
      args.headRefOid,
      args.ignoreWhitespace,
    ] as const,

  /**
   * Query key for one PR's local diff SUMMARY (`pr.getLocalDiffSummary`) -
   * the metadata frame of the split diff view. Identical identity parts to
   * {@link prQueryKeys.localDiff}, for the same reasons, under a distinct
   * segment so the two responses never share a slot.
   */
  localDiffSummary: (
    args: PrLocalDiffKeyIdentity & {
      readonly baseRefName: string;
      readonly headRefName: string;
      readonly headRefOid: string | null;
      readonly ignoreWhitespace: boolean;
    },
  ) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "localDiffSummary",
      args.epicId,
      args.linkGroupKey,
      args.owner,
      args.repo,
      args.repoRole,
      args.baseRefName,
      args.headRefName,
      args.headRefOid,
      args.ignoreWhitespace,
    ] as const,

  /**
   * See {@link localFileDiffScope} - the invalidation prefix for every
   * per-file entry under one PR's checkout.
   */
  localFileDiffScope,

  /**
   * Query key for ONE file's patch out of a summary-resolved range
   * (`pr.getLocalFileDiff`).
   *
   * Addressed by the summary's OID pair rather than ref names: commits are
   * immutable, so a `kind: "diff"` entry here can never be stale for its key
   * even while the checkout moves underneath. (An `unavailable` answer is NOT
   * immutable - it describes repo state - which is why the tile invalidates
   * this key's {@link localFileDiffScope} prefix on refresh and drift
   * recovery.) `epicId`/`linkGroupKey`/`repoRole` stay in the key for the
   * same identity reasons as `localDiff`. `byteBudget` is in it because the
   * capped and the load-full answers are different payloads.
   */
  localFileDiff: (
    args: PrLocalDiffKeyIdentity & {
      readonly mergeBaseOid: string;
      readonly headOid: string;
      readonly path: string;
      readonly previousPath: string | null;
      // The byte-path sidecars are part of the key because they are part of
      // the request identity: two files whose lossy `path` strings collide
      // differ ONLY in their tokens, and sharing a slot would hand one
      // file's patch to the other.
      readonly pathBytes: string | null;
      readonly previousPathBytes: string | null;
      readonly ignoreWhitespace: boolean;
      readonly byteBudget: number | null;
    },
  ) =>
    [
      ...localFileDiffScope(args),
      args.mergeBaseOid,
      args.headOid,
      args.path,
      args.previousPath,
      args.pathBytes,
      args.previousPathBytes,
      args.ignoreWhitespace,
      args.byteBudget,
    ] as const,
};
