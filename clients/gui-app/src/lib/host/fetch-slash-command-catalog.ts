import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GuiHarnessId,
  HostRpcRegistry,
  ListGuiAgentCommandsResponse,
} from "@traycer/protocol/host/index";

import { hostQueryKeys } from "@/lib/query-keys";
import { guiHarnessCommandsQueryParams } from "@/hooks/harnesses/use-gui-harness-catalog";
import { HARNESS_CATALOG_REFRESH_AFTER_MS } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  slashCommandCatalogFrom,
  slashCommandsFromOptions,
} from "@/lib/composer/slash-command-catalog";
import type { SlashCommandCatalog } from "@/lib/composer/tiptap-json-content";

export interface FetchSlashCommandCatalogArgs {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly harnessId: GuiHarnessId;
  readonly workingDirectories: ReadonlyArray<string>;
}

/**
 * Resolves the command catalog for a submit that needs it, awaiting the fetch
 * when the cache is cold.
 *
 * A `$` chip is catalog-gated (see `buildSubmittedChatJSONContent`), so a send
 * that reads a not-yet-loaded catalog does not merely lose a pill - it ships
 * the skill to the host as ordinary prose, where neither the structural nor the
 * lexical resolver can see it, and the skill silently never runs. The tile's
 * reactive subscription is `surfaceFocused`-gated and starts cold, so a next
 * step clicked promptly after a tile opens hits exactly that window.
 *
 * gui-app routes host RPC through TanStack Query, but a click is imperative, so
 * this goes through `fetchQuery` rather than a render-bound `useHostQuery`
 * (mirrors `fetchWorkspaceFileExists`). It shares the observer's key and
 * `staleTime`, so a warm catalog resolves from cache without a request and a
 * cold one populates the very slot the composer's subscription reads.
 *
 * Returns `null` when the catalog cannot be resolved - no host client, or the
 * request failed. The caller then submits against a `null` catalog, which is
 * the pre-existing degrade: the `$` stays prose rather than the message being
 * dropped or the chip being invented from an unverified name.
 */
export async function fetchSlashCommandCatalog(
  args: FetchSlashCommandCatalogArgs,
): Promise<SlashCommandCatalog | null> {
  const { client } = args;
  if (client === null) return null;
  const params = guiHarnessCommandsQueryParams(
    args.harnessId,
    args.workingDirectories,
  );
  return args.queryClient
    .fetchQuery({
      queryKey: hostQueryKeys.method<HostRpcRegistry, "agent.gui.listCommands">(
        args.hostId,
        "agent.gui.listCommands",
        params,
      ),
      queryFn: (): Promise<ListGuiAgentCommandsResponse> =>
        client.request("agent.gui.listCommands", params),
      staleTime: HARNESS_CATALOG_REFRESH_AFTER_MS,
    })
    .then((response) =>
      slashCommandCatalogFrom(slashCommandsFromOptions(response.commands)),
    )
    .catch(() => null);
}
