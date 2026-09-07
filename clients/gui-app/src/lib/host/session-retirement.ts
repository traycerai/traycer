/**
 * The auth-transition trigger for retiring cached remote sessions (`retireAllRemoteSessions`), extracted from the host-runtime provider so the PREDICATE - which transition sweeps - is pinned by its own tests.
 */
export function createSessionRetirementSweep<Context extends object>(options: {
  /** Live read of the current auth context (`RequestContextProvider.current`). */
  readonly currentContext: () => Context | null;
  /** The sweep itself (`retireAllRemoteSessions`). */
  readonly retire: () => void;
}): () => void {
  // The context whose sessions the cache currently holds - captured at creation, so a provider mounting under an already-signed-in user does not sweep the sessions that user legitimately built before this mount.
  let cachedSessionsContext = options.currentContext();
  return () => {
    const liveContext = options.currentContext();
    if (liveContext !== cachedSessionsContext) {
      cachedSessionsContext = liveContext;
      options.retire();
    }
  };
}
