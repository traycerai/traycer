/**
 * Like TanStack's `keepPreviousData`, but drops the prior result when the
 * previous query's hostId key segment differs from `currentHostId`.
 *
 * Host queries are keyed `["host", hostId, method, params]`. Bare
 * `keepPreviousData` retains the previous host's payload across a switch and
 * can render its verdict as the new host's data while the new fetch is in
 * flight. Returning `undefined` on a host mismatch forces the pending branch
 * until the new host answers.
 *
 * Path / query-string changes under the same host still retain the prior
 * payload (no flash on every keystroke or folder edit).
 *
 * The returned function is itself generic over `T` (same shape as
 * `keepPreviousData`) so each `placeholderData` slot can infer its data type.
 * `previousQuery` is typed structurally (only `queryKey`) so the callback is
 * assignable regardless of the query's error type — TanStack's
 * `Query<…, HostRpcError, …>` is invariant in the error type.
 */
export function keepPreviousDataForSameHost(
  currentHostId: string | null,
): <T>(
  previousData: T | undefined,
  previousQuery: { readonly queryKey: readonly unknown[] } | undefined,
) => T | undefined {
  return (previousData, previousQuery) => {
    if (previousData === undefined) return undefined;
    if (previousQuery === undefined) return previousData;
    const previousKey = previousQuery.queryKey;
    // Host-scoped keys only: non-host queries (or a key that has not yet
    // settled a hostId) keep the retain-while-refetching behaviour.
    if (previousKey[0] === "host" && previousKey[1] !== currentHostId) {
      return undefined;
    }
    return previousData;
  };
}
