/**
 * Query key builders for the `pr.*` host stream surface.
 * Scope: `pr-panel-and-list-hook` ticket (Epic PR View T5).
 */

import { hostQueryKeys } from "./host-query-keys";

/** The identity every local-diff key variant shares below the host scope. */
interface PrLocalDiffKeyIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly linkGroupKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoRole: string;
}

/**
 * Key PREFIX for every `pr.getLocalFileDiff` entry belonging to one PR's checkout, exported for INVALIDATION: the tile's manual refresh and its range-drift recovery both need "clear every per-file answer under this checkout" without knowing which OID pairs.
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
   * Query key for the epic-scoped PR list cache (`pr.subscribeListForEpic`).
   * Scoped by `(hostId, epicId)` only - NOT by `mode`: a background and a foreground subscription for the same epic feed the same cache entry (the host runs one poller per `(hostId, epicId)` regardless of how many modes are subscribed).
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
   * Scoped by `(hostId, epicId, githubHost, owner, repo, prNumber)`.
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

  /** Query key for one PR's LOCAL diff (`pr.getLocalDiff`). */
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
   * Query key for one PR's local diff SUMMARY (`pr.getLocalDiffSummary`) - the metadata frame of the split diff view.
   * Identical identity parts to {@link prQueryKeys.localDiff}, for the same reasons, under a distinct segment so the two responses never share a slot.
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

  /** See {@link localFileDiffScope} - the invalidation prefix for every per-file entry under one PR's checkout. */
  localFileDiffScope,

  /** Query key for ONE file's patch out of a summary-resolved range (`pr.getLocalFileDiff`). */
  localFileDiff: (
    args: PrLocalDiffKeyIdentity & {
      readonly mergeBaseOid: string;
      readonly headOid: string;
      readonly path: string;
      readonly previousPath: string | null;
      // The byte-path sidecars are part of the key because they are part of the request identity: two files whose lossy `path` strings collide differ ONLY in their tokens, and sharing a slot would hand one file's patch to the other.
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
