/**
 * Must equal `joinResponseTimeoutMs` for `providers.refreshPackDiscovery` in `host-method-policy-table.ts`; pass via `useHostMutationWithResponseTimeout`.
 * 660s = 15 packs x 4 x 10s + 60s, zero slack. Pin: `traycer-host/src/domain/providers/__tests__/provider-pack-count-fits-gui-discovery-check-budget.test.ts`.
 */
export const PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS = 11 * 60 * 1000;
