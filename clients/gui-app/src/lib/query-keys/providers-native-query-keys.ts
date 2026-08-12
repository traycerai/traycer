import type { QueryKey } from "@tanstack/react-query";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderNativeScope,
  ProviderPluginIconTheme,
} from "@traycer/protocol/host/provider-native-schemas";
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

export function nativePluginIconParams(
  args: NativeListScopeParams & {
    readonly pluginId: string;
    readonly theme: ProviderPluginIconTheme;
  },
): ProvidersListWireParams {
  return {
    native: {
      kind: "pluginIcon",
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
      pluginId: args.pluginId,
      theme: args.theme,
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

  // `version` rides the KEY but not `nativePluginIconParams` - it is cache
  // identity, not a request field. The host always serves the newest installed
  // version, so the request needs only the id; the version is what retires the
  // previous version's entry, which `staleTime: Infinity` would otherwise
  // strand. Must stay in step with `useProvidersPluginIcon`'s
  // `cacheKeyIdentity`, or a key built here would address nothing.
  pluginIcon: (
    hostId: string | null,
    params: NativeListScopeParams & {
      readonly pluginId: string;
      readonly theme: ProviderPluginIconTheme;
      readonly version: string | null;
    },
  ): QueryKey => [
    ...hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      hostId,
      "providers.list",
      nativePluginIconParams(params),
    ),
    "providers",
    "native",
    "pluginIcon",
    params.version,
  ],

  /**
   * Matches EVERY cached icon on one host, whatever plugin, theme or version.
   *
   * A predicate rather than a prefix because the discriminating segments sit on
   * both sides of the request params: `pluginId` and `theme` ride inside them,
   * and `version` trails after. No prefix covers the family, and a per-plugin
   * one would still miss the case this exists for.
   *
   * Needed because `version` is NULLABLE. For a versioned plugin a reinstall
   * changes the key and retires the old entry by itself; for one that reports
   * no version the key is identical across reinstalls, and with
   * `staleTime: Infinity` and no polling that entry would serve the previous
   * install's artwork for the rest of the session.
   */
  isPluginIconKey: (hostId: string | null, key: QueryKey): boolean => {
    const scope = hostQueryKeys.scope(hostId);
    if (key.length < scope.length) return false;
    for (let i = 0; i < scope.length; i += 1) {
      if (key[i] !== scope[i]) return false;
    }
    return key.includes("pluginIcon");
  },

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
