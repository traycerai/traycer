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
   * Query key for one PR's heavy detail cache (`pr.subscribeDetail`). Scoped
   * by `(hostId, githubHost, owner, repo, prNumber)` - NOT by `epicId`: the
   * heavy fact is host-global (tech plan: "a PR shared by two epics is one
   * row"), so tiles opened from different epics for the same PR on the same
   * host share one cache entry.
   */
  detail: (args: {
    readonly hostId: string;
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "pr",
      "detail",
      args.githubHost,
      args.owner,
      args.repo,
      args.prNumber,
    ] as const,
};
