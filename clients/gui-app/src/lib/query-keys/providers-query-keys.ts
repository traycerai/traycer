import {
  hashKey,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

// Any provider override change can flip a provider's availability (enabled
// toggle, selecting a binary that can't launch, or setting/clearing an API key
// like Cursor's), so every provider mutation refreshes the Settings panel,
// both harness selectors, the generated agent-selection-guide default, and the
// auto-mode judge's blocker verdict. The guide invalidation recomputes only the
// generated default; it does not write the user's global guide file.
//
// This list is BOTH mechanisms' source of truth, which is why the harness
// catalogs live here and nowhere else. Mutations that go through
// `useHostScopedMutation` consume it as `invalidateMethods`; the paths that
// write `providers.list` DIRECTLY (a login-completion echo, a force-refresh)
// consume it through `commitAuthoritativeProvidersList`, which invalidates
// every method here except `providers.list` itself - the one it has just
// written authoritatively. So a direct-write path needs no hand-rolled
// catalog invalidation of its own: adding one only marks the freshly refetched
// catalogs stale again and starts a second, redundant pair of RPCs.
export const PROVIDER_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "providers.list",
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
  "agent.selectionGuide.getGlobal",
  "agent.selectionGuide.getGlobalOnboardingDraft",
  // `autoJudge.get` answers a `blocked` verdict whose first reason is literally
  // `provider-disabled`, so the judge's blockers are a FUNCTION of the
  // configuration these mutations change. Without this entry the response was
  // cached indefinitely while mounted: enabling the judge's provider left the
  // Auto row saying no judge would run, and disabling it left the billing copy
  // promising that provider's account. The other two reads it could reach are
  // deliberately absent - `autoJudge.set` is a write, and `autoPolicy.get`
  // proxies an ACCOUNT record (body, stamp, read state, the host's bundled
  // defaults) that no provider override touches.
  "autoJudge.get",
];

export function providersListQueryKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    { native: null },
  );
}

/** Versioned artwork is immutable; unversioned icons still need catch-up. */
export function isMutableProviderQuery(
  queryKey: QueryKey,
  providerId: string | null,
): boolean {
  if (queryKey[2] !== "providers.list") return true;
  const params = queryKey[3];
  if (params === null || typeof params !== "object" || !("native" in params)) {
    return true;
  }
  const native = params.native;
  if (native === null || typeof native !== "object") return true;
  if (
    "kind" in native &&
    native.kind === "pluginIcon" &&
    queryKey[6] === "pluginIcon" &&
    typeof queryKey[7] === "string" &&
    queryKey[7].length > 0
  )
    return false;
  return (
    providerId === null ||
    ("providerId" in native && native.providerId === providerId)
  );
}

interface ProviderInvalidation {
  dirty: boolean;
}
const providerInvalidations = new WeakMap<
  QueryClient,
  Map<string, ProviderInvalidation>
>();

function selectsProviderQuery(
  query: Query,
  providerIds:
    | ReadonlyArray<string | null>
    | "classic"
    | { readonly receivedBy: number },
  classicKey: string,
): boolean {
  if (providerIds === "classic") return query.queryHash === classicKey;
  if ("receivedBy" in providerIds) {
    const { state } = query;
    const cutoff = providerIds.receivedBy;
    return (
      ((state.dataUpdatedAt !== 0 && state.dataUpdatedAt <= cutoff) ||
        (state.status === "error" && state.errorUpdatedAt <= cutoff)) &&
      isMutableProviderQuery(query.queryKey, null)
    );
  }
  return providerIds.some((providerId) =>
    isMutableProviderQuery(query.queryKey, providerId),
  );
}

/**
 * A burst owns one refresh; a change during that refresh retains one successor.
 * `{ receivedBy }` selects every provider's queries answered (data or error)
 * no later than that instant, leaving newer and still-unanswered reads alone.
 */
export function invalidateProviderFamilyQueries(
  queryClient: QueryClient,
  hostId: string,
  methods: ReadonlyArray<keyof HostRpcRegistry & string>,
  providerIds:
    | ReadonlyArray<string | null>
    | "classic"
    | { readonly receivedBy: number },
): void {
  let pending = providerInvalidations.get(queryClient);
  if (pending === undefined) {
    pending = new Map();
    providerInvalidations.set(queryClient, pending);
  }
  const classicKey = hashKey(providersListQueryKey(hostId));
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: hostQueryKeys.scope(hostId),
    predicate: (query) =>
      methods.some((method) => query.queryKey[2] === method) &&
      selectsProviderQuery(query, providerIds, classicKey),
  })) {
    const existing = pending.get(query.queryHash);
    if (existing !== undefined) {
      existing.dirty = true;
      continue;
    }
    const entry: ProviderInvalidation = { dirty: true };
    pending.set(query.queryHash, entry);
    const owner = pending;
    queueMicrotask(() => {
      void (async () => {
        do {
          entry.dirty = false;
          // Do not revive a removed/replaced query (logout or an authoritative write).
          if (queryClient.getQueryCache().get(query.queryHash) !== query)
            return;
          const filters = { queryKey: query.queryKey, exact: true };
          await queryClient.cancelQueries(filters);
          await queryClient.invalidateQueries(filters);
        } while (owner.get(query.queryHash)?.dirty);
      })().finally(() => {
        if (owner.get(query.queryHash) === entry) owner.delete(query.queryHash);
      });
    });
  }
}

export function invalidateHostMutationQueries(
  queryClient: QueryClient,
  hostId: string,
  methods: ReadonlyArray<keyof HostRpcRegistry & string>,
  variables: unknown,
): void {
  const providerId =
    typeof variables === "object" &&
    variables !== null &&
    "providerId" in variables &&
    typeof variables.providerId === "string"
      ? variables.providerId
      : null;
  const family = methods.filter((method) =>
    PROVIDER_INVALIDATIONS.includes(method),
  );
  invalidateProviderFamilyQueries(queryClient, hostId, family, [providerId]);
  for (const method of methods) {
    if (!PROVIDER_INVALIDATIONS.includes(method)) {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, method),
      });
    }
  }
}
