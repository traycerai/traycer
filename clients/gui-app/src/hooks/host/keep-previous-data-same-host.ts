/** keepPreviousData only while hostId matches. A host switch must drop the prior payload. */
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
