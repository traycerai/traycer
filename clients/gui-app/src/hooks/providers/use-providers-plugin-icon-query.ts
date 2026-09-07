import { use } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderNativeScope,
  ProviderPluginIconTheme,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import {
  mapProvidersListToPluginIcon,
  type PluginIconData,
} from "@/hooks/providers/native-response-map";
import { nativePluginIconParams } from "@/lib/query-keys/providers-native-query-keys";

/** staleTime Infinity; include installed version in cacheKeyIdentity. Enable only when plugin.hasIcon. */
export function useProvidersPluginIcon(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly pluginId: string;
  readonly version: string | null;
  /** From the list row - see `theme` below for why it gates the request. */
  readonly hasDarkIcon: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PluginIconData, HostRpcError> {
  const client = useHostClient();
  // Read the context directly rather than through `useResolvedTheme()`, which THROWS when no <ThemeProvider> is above it.
  // Artwork is decoration; it must never be the reason a settings pane fails to render.
  const themeContext = use(ResolvedThemeContext);
  const resolvedTheme = themeContext?.resolvedTheme ?? "light";
  // Plugins with no dark asset are pinned to `light` so their request - and therefore their CACHE KEY - does not vary with theme.
  // Without this, a theme flip would miss on every row and re-fetch the whole ~900 KB set only to receive byte-identical images back.
  const theme: ProviderPluginIconTheme =
    args.hasDarkIcon && resolvedTheme === "dark" ? "dark" : "light";
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    PluginIconData
  >({
    cacheKeyIdentity: ["providers", "native", "pluginIcon", args.version],
    client,
    method: "providers.list",
    params: nativePluginIconParams({
      providerId: args.providerId,
      scope: args.scope,
      workspaceRoot: args.workspaceRoot,
      pluginId: args.pluginId,
      theme,
    }),
    mapResponse: ({ response }) => mapProvidersListToPluginIcon({ response }),
    options: {
      enabled: args.enabled,
      staleTime: Infinity,
      // `providers.list` is a condition-polled method and condition queries join the table-owned poll BY DEFAULT, so omitting this would put every icon on a refetch timer - and `refetchInterval` fires regardless of `staleTime`, so the Infinity above would not save it.
      poll: false,
      // That default is the one this hook wants anyway - a host predating the `pluginIcon` arm rejects the request outright, and re-asking costs real round trips for a decoration that already has a working fallback.
    },
  });
}
