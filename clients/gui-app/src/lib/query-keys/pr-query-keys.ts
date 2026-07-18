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
};
