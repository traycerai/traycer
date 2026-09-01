import { hashKey, type QueryClient } from "@tanstack/react-query";

export interface LocalFirstRevalidationLease {
  readonly identity: string;
  readonly generation: number;
}

interface LocalFirstRevalidationEpisode {
  readonly generation: number;
  readonly claimed: boolean;
}

// The QueryClient owns History's cache lifetime, so it also owns this finite
// revalidation budget. A hook-local ref permits one mutation per observer;
// modal/tab remounts can overlap, so the budget has to be shared at this
// layer. `beginLocalFirstRevalidationEpisode` runs inside the first-page
// queryFn, so every actual TanStack dispatch advances the episode before
// network work starts: raw refetches and active invalidations cannot bypass it.
// The key set intentionally follows the query cache's own Infinity lifetime
// rather than silently forgetting a completed episode and retrying.
const episodesByQueryClient = new WeakMap<
  QueryClient,
  Map<string, LocalFirstRevalidationEpisode>
>();

export function claimLocalFirstRevalidation(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): LocalFirstRevalidationLease | null {
  const identity = localFirstRevalidationIdentity(queryKey);
  const episodes = episodesFor(queryClient);
  const existing = episodes.get(identity);
  if (existing?.claimed === true) return null;
  const generation = existing?.generation ?? 0;
  episodes.set(identity, { generation, claimed: true });
  return { identity, generation };
}

/**
 * Opens a new finite-revalidation episode for a first-page query dispatch.
 * Supersedes an in-flight follow-up from an earlier response before this
 * initial request can replace its cache value.
 */
export function beginLocalFirstRevalidationEpisode(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): void {
  const identity = localFirstRevalidationIdentity(queryKey);
  const episodes = episodesFor(queryClient);
  const existing = episodes.get(identity);
  episodes.set(identity, {
    generation: (existing?.generation ?? 0) + 1,
    claimed: false,
  });
}

export function isCurrentLocalFirstRevalidation(
  queryClient: QueryClient,
  lease: LocalFirstRevalidationLease,
): boolean {
  const episode = episodesFor(queryClient).get(lease.identity);
  return episode?.claimed === true && episode.generation === lease.generation;
}

/**
 * Hands the episode back once the follow-up it was claimed for has SETTLED,
 * either way. The generation is kept - a later dispatch still supersedes -
 * but the claim is released so the same episode can be claimed again.
 *
 * Without this a claim was permanent for the life of the episode, and one
 * ordinary sequence stranded it: authorization lost after the claim, the
 * page demoted from `pending` to `unavailable` so the arriving result could
 * not replace it, then authorization restored and the page reopened to
 * `pending` - which re-ran the dispatch effect, found the episode still
 * claimed, and refused. With mount/focus/reconnect refetching disabled and
 * an infinite `staleTime`, the cloud rows then stayed absent until an
 * explicit refresh began a new episode.
 *
 * A stale lease (superseded by a newer episode) releases nothing: the claim
 * it would clear belongs to the newer dispatch.
 */
export function releaseLocalFirstRevalidation(
  queryClient: QueryClient,
  lease: LocalFirstRevalidationLease,
): void {
  const episodes = episodesFor(queryClient);
  const episode = episodes.get(lease.identity);
  if (episode === undefined || episode.generation !== lease.generation) return;
  if (!episode.claimed) return;
  episodes.set(lease.identity, {
    generation: episode.generation,
    claimed: false,
  });
}

function episodesFor(
  queryClient: QueryClient,
): Map<string, LocalFirstRevalidationEpisode> {
  const existing = episodesByQueryClient.get(queryClient);
  if (existing !== undefined) return existing;
  const episodes = new Map<string, LocalFirstRevalidationEpisode>();
  episodesByQueryClient.set(queryClient, episodes);
  return episodes;
}

function localFirstRevalidationIdentity(queryKey: readonly unknown[]): string {
  // This state belongs to one TanStack Query, so it must use the same stable
  // object-key canonicalization as TanStack rather than a lookalike serializer.
  return hashKey(queryKey);
}
