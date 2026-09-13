/**
 * Mutation keys for the host's local-store lifecycle.
 *
 * The rebind is the fail-closed store's only repair route, and it is triggered
 * from a surface (the snapshot error banner) that is deliberately outside the
 * tile tree. Any other surface that needs to observe the in-flight repair has
 * to name the same key, so it lives here rather than inline at the hook.
 */
export const localStoreMutationKeys = {
  rebind: () => ["host.rebindLocalStore"] as const,
} as const;
