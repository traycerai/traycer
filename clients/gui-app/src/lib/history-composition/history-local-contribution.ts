import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ViewReplicaAddress } from "@traycer-clients/shared/view-replica/identity";
import {
  listTasksSortSchema,
  type ListTasksResponse,
  type TaskFilters,
} from "@traycer/protocol/host/epic/unary-schemas";
import { z } from "zod";
import type { HostRpcRegistry } from "@/lib/host";
import {
  composeHistoryPage,
  type HistoryHostContribution,
} from "@/lib/history-composition/compose-history-page";

/**
 * The host's contribution to the UNFILTERED History listing, as this client
 * last learned it, per account and host. A cached History page paints only
 * through it (`historyReplicaService`'s paint gate): `pending` holds the
 * paint, because a page painted before the host said which tasks it deleted
 * could show one of them.
 */
export type HistoryHostContributionState =
  | { readonly kind: "pending" }
  | HistoryHostContribution;

/**
 * Reads the host's contribution for `filters`. A host whose local store may
 * still open answers `complete: false, willComplete: true`; the read then
 * asks again with `awaitComplete`, which the host holds until the store has
 * opened or settled as unavailable, so nothing here waits on a timer.
 * `onIncomplete` hears that first answer, for a caller that holds a paint on
 * it.
 *
 * Everything that is not a complete answer - no client, a host that predates
 * the method, a transport failure, a store that cannot be read - is `absent`:
 * the page is composed as the pool's alone and states reduced coverage. Only
 * the caller's own abort rejects.
 */
export async function readHistoryHostContribution(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly filters: TaskFilters | null;
  readonly signal: AbortSignal | undefined;
  readonly onIncomplete: (() => void) | null;
}): Promise<HistoryHostContribution> {
  const { client, signal } = input;
  if (client === null) return ABSENT;
  let awaitComplete = false;
  for (;;) {
    const read = await client
      .requestWithSignal(
        "epic.localHistory.read",
        { filters: input.filters, awaitComplete },
        signal,
      )
      .catch((error: unknown) => {
        if (signal?.aborted === true) throw error;
        return null;
      });
    if (read === null) return ABSENT;
    if (read.complete) return { kind: "contributed", read };
    if (!read.willComplete) return ABSENT;
    if (!awaitComplete) input.onIncomplete?.();
    awaitComplete = true;
  }
}

const ABSENT: HistoryHostContribution = { kind: "absent" };

const unfiltered = new Map<string, HistoryHostContributionState>();
const listeners = new Set<() => void>();

function scopeKey(accountId: string, hostId: string): string {
  return JSON.stringify([accountId, hostId]);
}

/** Records what the host contributes to the unfiltered listing. */
export function noteUnfilteredHistoryContribution(
  accountId: string,
  hostId: string,
  state: HistoryHostContributionState,
): void {
  unfiltered.set(scopeKey(accountId, hostId), state);
  for (const listener of [...listeners]) listener();
}

export function unfilteredHistoryContribution(
  accountId: string,
  hostId: string,
): HistoryHostContributionState | undefined {
  return unfiltered.get(scopeKey(accountId, hostId));
}

export function subscribeUnfilteredHistoryContributions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget every recorded contribution. */
export function __resetHistoryContributionsForTests(): void {
  unfiltered.clear();
}

const cachedRequestScopeSchema = z.object({
  sort: listTasksSortSchema.optional(),
});

/**
 * The paint gate's application of the contribution to a cached first page
 * (`historyReplicaService` keeps only the unfiltered listing, one per sort).
 * `null` holds the paint: the host's contribution has not been learned, or
 * may still complete. A host that cannot contribute paints the pool's page
 * with its reduced coverage stated.
 */
export function applyHistoryContributionToCachedPage(
  page: ListTasksResponse,
  address: ViewReplicaAddress,
  hostId: string | null,
): ListTasksResponse | null {
  const state =
    hostId === null
      ? ABSENT
      : unfilteredHistoryContribution(address.accountId, hostId);
  if (state === undefined || state.kind === "pending") return null;
  return composeHistoryPage({
    page,
    contribution: state,
    sort: cachedRequestSort(address.requestScope),
    query: undefined,
    placement: "admit",
  });
}

function cachedRequestSort(
  requestScope: string,
): z.infer<typeof listTasksSortSchema> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(requestScope);
  } catch {
    return undefined;
  }
  const parsed = cachedRequestScopeSchema.safeParse(raw);
  return parsed.success ? parsed.data.sort : undefined;
}
