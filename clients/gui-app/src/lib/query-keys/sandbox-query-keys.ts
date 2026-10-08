/**
 * Query and mutation keys for the sandbox control plane (`/api/sandboxes`),
 * read through `AuthService` like the host registry.
 */
export const sandboxQueryKeys = {
  // UNDER the `registeredHostsAll` prefix on purpose: a sandbox row and its
  // host-list row describe one machine, so the directory's one liveness tick
  // (`onRegistryPollTick`) refreshes both, and no second timer runs against
  // traycer-server. Keyed to the live AuthService and signed-in user for the
  // reason `authQueryKeys.registeredHosts` gives.
  list: (authService: object, userId: string | null): readonly unknown[] => [
    "auth",
    "registered-hosts",
    "sandboxes",
    authService,
    userId,
  ],
  listMissing: (): readonly unknown[] => [
    "auth",
    "registered-hosts",
    "sandboxes",
    "missing",
  ],
  catalogue: (
    authService: object,
    userId: string | null,
  ): readonly unknown[] => ["auth", "sandbox-catalogue", authService, userId],
  catalogueMissing: (): readonly unknown[] => [
    "auth",
    "sandbox-catalogue",
    "missing",
  ],
};

export const sandboxMutationKeys = {
  create: () => ["auth", "sandbox", "create"] as const,
  // Per sandbox, so two destroys never share a pending state.
  destroy: (sandboxId: string) =>
    ["auth", "sandbox", "destroy", sandboxId] as const,
  // Per HOST: the tab open that wakes it knows the host, not the sandbox id.
  wake: (hostId: string) => ["auth", "sandbox", "wake", hostId] as const,
};
