/**
 * The auth-transition trigger for retiring cached remote sessions
 * (`retireAllRemoteSessions`), extracted from the host-runtime provider so
 * the PREDICATE - which transition sweeps - is pinned by its own tests.
 *
 * Supersession is otherwise only detected when someone ACQUIRES a session, so
 * without this sweep a retired auth context's still-attached sessions keep
 * answering `hasReadyRemoteSession` for up to the keep-warm window -
 * rendering hosts Online to the next identity, off connections whose
 * credential lease the transition released.
 *
 * The comparison is the context OBJECT REFERENCE, deliberately not the
 * userId:
 *
 *  - A same-user token refresh rotates the lease INSIDE the current context
 *    (`rotateCurrentBearer`), keeping the reference - so it correctly does
 *    not sweep, and the shared connections survive a refresh.
 *  - Every genuine transition hands over a fresh context object: sign-out
 *    (A -> null), sign-in (null -> A), a DIRECT account switch (A -> B, which
 *    a cross-window projection or credential-file reconcile performs without
 *    ever passing through null), AND a same-user re-sign-in that mints a
 *    fresh context (A -> A' - the provider documents "auth-resigned-in" as a
 *    legitimate operation; its fresh lease means a fresh auth epoch, so the
 *    old epoch's sessions are exactly as retired as a signed-out user's).
 *
 * A userId comparison would miss A -> A' and hold only for as long as
 * `applySignedIn` happens to rotate in place - two repairs mutually
 * load-bearing with nothing pinning the coupling.
 */
export function createSessionRetirementSweep<Context extends object>(options: {
  /** Live read of the current auth context (`RequestContextProvider.current`). */
  readonly currentContext: () => Context | null;
  /** The sweep itself (`retireAllRemoteSessions`). */
  readonly retire: () => void;
}): () => void {
  // The context whose sessions the cache currently holds - captured at
  // creation, so a provider mounting under an already-signed-in user does not
  // sweep the sessions that user legitimately built before this mount.
  let cachedSessionsContext = options.currentContext();
  return () => {
    const liveContext = options.currentContext();
    if (liveContext !== cachedSessionsContext) {
      cachedSessionsContext = liveContext;
      options.retire();
    }
  };
}
