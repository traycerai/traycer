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

/**
 * One plugin's artwork, fetched per row.
 *
 * Separate from `useProvidersPluginsList` on purpose. That list runs
 * `staleTime: 30_000`, and the icons behind it are ~900 KB of PNG in
 * aggregate (~1.2 MB base64) for a typical Codex install - one 1024x1024 file
 * alone is 451 KB. Riding the list would re-send all of it twice a minute for
 * a set of images that essentially never change.
 *
 * Hence the inverse cache policy here: `staleTime: Infinity`. A plugin's icon
 * is immutable for a given installed VERSION - which is why the version has to
 * be part of the cache identity. The wire request addresses the plugin by id
 * alone (the host always reads the newest installed version), so without this
 * an upgrade performed outside the app would leave the old artwork cached for
 * the rest of the session: `staleTime: Infinity` and `poll: false` mean this
 * query is never refetched on its own, and the new version arrives only on the
 * LIST. `cacheKeyIdentity` exists for exactly this shape - a stable resource id
 * whose cached representation must vary by a content identity.
 *
 * Callers should pass `enabled: plugin.hasIcon` - the list already reports
 * whether artwork exists, so rows without it never make the round trip.
 */
export function useProvidersPluginIcon(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly pluginId: string;
  /**
   * The installed version from the list row. Cache identity only - it is not
   * sent, because the host resolves the newest version itself. A change here
   * is what retires the previous version's artwork.
   */
  readonly version: string | null;
  /** From the list row - see `theme` below for why it gates the request. */
  readonly hasDarkIcon: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PluginIconData, HostRpcError> {
  const client = useHostClient();
  // Read the context directly rather than through `useResolvedTheme()`, which
  // THROWS when no <ThemeProvider> is above it. Artwork is decoration; it must
  // never be the reason a settings pane fails to render. Light is the safe
  // default - it is the asset every plugin ships.
  const themeContext = use(ResolvedThemeContext);
  const resolvedTheme = themeContext?.resolvedTheme ?? "light";
  // Plugins with no dark asset are pinned to `light` so their request - and
  // therefore their CACHE KEY - does not vary with theme. Without this, a
  // theme flip would miss on every row and re-fetch the whole ~900 KB set only
  // to receive byte-identical images back.
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
      // MUST stay false. `providers.list` is a condition-polled method and
      // condition queries join the table-owned poll BY DEFAULT, so omitting
      // this would put every icon on a refetch timer - and `refetchInterval`
      // fires regardless of `staleTime`, so the Infinity above would not save
      // it. That is precisely the megabytes-on-a-timer this hook exists to
      // avoid. An installed plugin's artwork is immutable for its version, and
      // `cacheKeyIdentity` above carries that version, so an upgrade retires
      // the old entry rather than needing a refetch of the unchanged one.
      poll: false,
      // No `retry` here: `providers.list` is a condition-polled method, so the
      // shared poll table already pins `retry: false` and the option is typed
      // away from callers. That default is the one this hook wants anyway - a
      // host predating the `pluginIcon` arm rejects the request outright, and
      // re-asking costs real round trips for a decoration that already has a
      // working fallback.
    },
  });
}
