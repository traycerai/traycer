import type { QueryKey } from "@tanstack/react-query";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

export type ProvidersListWireParams = RequestOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

export type NativeListScopeParams = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
};

/** Classic catalog list params (`native: null`). Shared by list/refresh/await. */
export const CLASSIC_PROVIDERS_LIST_PARAMS: ProvidersListWireParams = {
  native: null,
};

export function nativeMcpListParams(
  args: NativeListScopeParams,
): ProvidersListWireParams {
  return {
    native: {
      kind: "mcp",
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
    },
  };
}

export function nativePluginsListParams(
  args: NativeListScopeParams,
): ProvidersListWireParams {
  return {
    native: {
      kind: "plugins",
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
    },
  };
}

export function nativeSkillsListParams(
  args: NativeListScopeParams,
): ProvidersListWireParams {
  return {
    native: {
      kind: "skills",
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
    },
  };
}

export function nativeMcpDiscoverParams(
  args: NativeListScopeParams & {
    readonly serverName: string;
    readonly forceRefresh: boolean;
  },
): ProvidersListWireParams {
  return {
    native: {
      kind: "mcpDiscover",
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
      serverName: args.serverName,
      forceRefresh: args.forceRefresh,
    },
  };
}

/**
 * Semantic native query-key family for MCP/plugins/skills list caches.
 *
 * Keys ride the real wire method (`providers.list`) with a `native` query so
 * they never collide with classic catalog reads (`native: null`). The
 * `["providers","native",kind]` segment makes invalidation discoverable and
 * independent of the deleted `providers.mcpList`-style method names.
 *
 * Full shape:
 * `["host", hostId, "providers.list", wireParams, "providers", "native", kind]`
 */
export const providersNativeQueryKeys = {
  /** Prefix shared by every native list/discover cache entry on a host. */
  base: (hostId: string | null): QueryKey => [
    ...hostQueryKeys.methodScope(hostId, "providers.list"),
    // wire params slot is next; use predicate invalidation for "all native"
  ],

  mcpList: (hostId: string | null, params: NativeListScopeParams): QueryKey => [
    ...hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      hostId,
      "providers.list",
      nativeMcpListParams(params),
    ),
    "providers",
    "native",
    "mcp",
  ],

  pluginsList: (
    hostId: string | null,
    params: NativeListScopeParams,
  ): QueryKey => [
    ...hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      hostId,
      "providers.list",
      nativePluginsListParams(params),
    ),
    "providers",
    "native",
    "plugins",
  ],

  skillsList: (
    hostId: string | null,
    params: NativeListScopeParams,
  ): QueryKey => [
    ...hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      hostId,
      "providers.list",
      nativeSkillsListParams(params),
    ),
    "providers",
    "native",
    "skills",
  ],

  /** Invalidate every mcp list entry for a host (all scopes/providers). */
  mcpKindScope: (hostId: string | null): QueryKey => [
    ...hostQueryKeys.methodScope(hostId, "providers.list"),
  ],
};

/**
 * Predicate: true when a query key is a native mcp list cache entry.
 * Used with invalidateQueries when a prefix alone would also hit classic list.
 */
export function isNativeMcpListQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey.includes("providers") &&
    queryKey.includes("native") &&
    queryKey.includes("mcp")
  );
}

export function isNativePluginsListQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return (
    queryKey.includes("providers") &&
    queryKey.includes("native") &&
    queryKey.includes("plugins")
  );
}

export function isNativeSkillsListQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return (
    queryKey.includes("providers") &&
    queryKey.includes("native") &&
    queryKey.includes("skills")
  );
}
