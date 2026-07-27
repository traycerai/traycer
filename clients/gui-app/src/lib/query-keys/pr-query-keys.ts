/**
 * Query key builders for the `pr.*` host stream surface.
 * Scope: `pr-panel-and-list-hook` ticket (Epic PR View T5).
 */

import { hostQueryKeys } from "./host-query-keys";

export const prQueryKeys = {
  /**
   * Query key for the epic-scoped PR list cache
   * (`pr.subscribeListForEpic`). Scoped by `(hostId, epicId)` only - NOT by
   * `mode`: a background and a foreground subscription for the same epic
   * feed the same cache entry (the host runs one poller per
   * `(hostId, epicId)` regardless of how many modes are subscribed).
   */
  listForEpic: (hostId: string | null, epicId: string) =>
    [...hostQueryKeys.scope(hostId), "pr", "listForEpic", epicId] as const,

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
  localDiff: (args: {
    readonly hostId: string;
    readonly epicId: string;
    readonly linkGroupKey: string;
    readonly owner: string;
    readonly repo: string;
    readonly baseRefName: string;
    readonly headRefName: string;
    readonly headRefOid: string | null;
    readonly ignoreWhitespace: boolean;
  }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "localDiff",
      args.epicId,
      args.linkGroupKey,
      args.owner,
      args.repo,
      args.baseRefName,
      args.headRefName,
      args.headRefOid,
      args.ignoreWhitespace,
    ] as const,
};
