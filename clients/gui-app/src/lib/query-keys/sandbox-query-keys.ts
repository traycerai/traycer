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
  // NOT under `registeredHostsAll`: the cost route reads each sandbox's
  // ledger, so it must not ride the directory's liveness tick. It refreshes
  // on focus and on the events `useRefreshSandboxCosts` names.
  costs: (authService: object, userId: string | null): readonly unknown[] => [
    "auth",
    "sandbox-costs",
    authService,
    userId,
  ],
  // Under `registeredHostsAll` like the list: the Automations row is a host
  // list row once it exists, so the same tick and the same invalidation
  // refresh it.
  // Per environment: a team's pods are one read per team, shared by every
  // pod card of it; `null` is the person's own Automations host.
  automation: (
    authService: object,
    userId: string | null,
    environmentId: string | null,
  ): readonly unknown[] => [
    "auth",
    "registered-hosts",
    "sandbox-automation",
    authService,
    userId,
    environmentId,
  ],
  automationMissing: (): readonly unknown[] => [
    "auth",
    "registered-hosts",
    "sandbox-automation",
    "missing",
  ],
  costsAll: (): readonly unknown[] => ["auth", "sandbox-costs"],
  costsMissing: (): readonly unknown[] => ["auth", "sandbox-costs", "missing"],
  catalogue: (
    authService: object,
    userId: string | null,
  ): readonly unknown[] => ["auth", "sandbox-catalogue", authService, userId],
  catalogueMissing: (): readonly unknown[] => [
    "auth",
    "sandbox-catalogue",
    "missing",
  ],
  // The broker's grants summary for one sandbox host. Not under
  // `registeredHostsAll`: it is a read of authn's grant set, refreshed on
  // focus and after a grant decision, never on the directory's liveness tick.
  grants: (
    authService: object,
    userId: string | null,
    environmentId: string | null,
    hostId: string,
  ): readonly unknown[] => [
    "auth",
    "sandbox-grants",
    authService,
    userId,
    environmentId,
    hostId,
  ],
  grantsAll: (): readonly unknown[] => ["auth", "sandbox-grants"],
  // A team's environment id: fixed once created, so read once per team per
  // session, and only for a team the person picked.
  teamEnvironment: (
    authService: object,
    userId: string | null,
    teamId: string,
  ): readonly unknown[] => [
    "auth",
    "team-environment",
    authService,
    userId,
    teamId,
  ],
  teamEnvironmentAll: (): readonly unknown[] => ["auth", "team-environment"],
  teamEnvironmentMissing: (): readonly unknown[] => [
    "auth",
    "team-environment",
    "missing",
  ],
  // An environment's provider counts: its API keys and linked plans.
  environmentProviders: (
    authService: object,
    userId: string | null,
    environmentId: string,
  ): readonly unknown[] => [
    "auth",
    "environment-providers",
    authService,
    userId,
    environmentId,
  ],
  environmentProvidersMissing: (): readonly unknown[] => [
    "auth",
    "environment-providers",
    "missing",
  ],
  grantsMissing: (): readonly unknown[] => [
    "auth",
    "sandbox-grants",
    "missing",
  ],
};

export const sandboxMutationKeys = {
  // Per account: a create can run for minutes, and one started by another
  // account (before a sign-out) must not hold this account's create form.
  create: (userId: string | null) =>
    ["auth", "sandbox", "create", userId] as const,
  // Per sandbox, so two destroys never share a pending state.
  destroy: (sandboxId: string) =>
    ["auth", "sandbox", "destroy", sandboxId] as const,
  // Per sandbox, like destroy: the card's suspend / resume / stop / start.
  verb: (sandboxId: string) => ["auth", "sandbox", "verb", sandboxId] as const,
  // Per sandbox, like destroy: the rename and the idle and resting periods.
  patch: (sandboxId: string) =>
    ["auth", "sandbox", "patch", sandboxId] as const,
  // Per sandbox, like destroy.
  keep: (sandboxId: string) => ["auth", "sandbox", "keep", sandboxId] as const,
  // Per HOST: the tab open that wakes it knows the host, not the sandbox id.
  wake: (hostId: string) => ["auth", "sandbox", "wake", hostId] as const,
  // Per account, like create: the first open creates the row and can take
  // minutes.
  automationOpen: (userId: string | null) =>
    ["auth", "sandbox", "automation-open", userId] as const,
  // Per request, so two approval cards never share a pending state.
  decideSecretRequest: (requestId: string) =>
    ["auth", "sandbox", "secret-request", "decide", requestId] as const,
  // A host RPC, not a control-plane call: the sandbox host repairs itself.
  repairGuestConfiguration: () =>
    ["host.sandbox.repairGuestConfiguration"] as const,
  // Per account: Settings' `Destroy all idle` over the filtered rows.
  destroyBatch: (userId: string | null) =>
    ["auth", "sandbox", "destroy-batch", userId] as const,
};
