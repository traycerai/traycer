import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { HostRpcRegistry } from "@/lib/host";
import { fetchSlashCommandCatalog } from "@/lib/host/fetch-slash-command-catalog";
import {
  buildSubmittedChatJSONContent,
  submittedContentNeedsSlashCatalog,
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";

export interface UseSlashCatalogResolverParams {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly harnessId: GuiHarnessId;
  /**
   * The RESOLVED roots the composer discovers commands under, not the raw chat
   * binding. Keying on anything else opens a second, narrower cache entry on a
   * folder-fallback chat.
   */
  readonly workingDirectories: ReadonlyArray<string>;
  /**
   * Reads the catalog this surface already holds, or `null` when it is loading,
   * errored, or not subscribed. Never report an empty map for a failed query -
   * an unanswered query is unresolved, not empty.
   *
   * A GETTER, deliberately, read at submit time. Subscribing to the value would
   * make every holder of this resolver re-render whenever the catalog's identity
   * churns, and the picker store re-publishes a freshly built Map - enough to
   * drive an infinite update loop through its own `setKnownSlashCommands`
   * effect. Nothing here needs to react to the catalog; it needs its value once,
   * at the moment of a submit. Pass a stable (`useCallback`) getter.
   */
  readonly getLoadedCatalog: () => SlashCommandCatalog | null;
}

/**
 * Builds submit content, resolving the command catalog first when - and only
 * when - the prompt needs it.
 *
 * A `$` chip is catalog-gated (see `buildSubmittedChatJSONContent`), so
 * converting against a catalog that has not loaded does not merely drop a pill:
 * it puts the skill on the wire as ordinary prose, where the host can resolve it
 * neither structurally nor lexically, and the turn runs without it. Every
 * surface that turns raw text into a submit therefore has to be able to wait.
 *
 * Returns `null` when the prompt needed the catalog and it could not be
 * resolved. Callers must treat that as "not sent" - surface it and keep the
 * action retryable - rather than sending the unconverted text.
 */
export function useSlashCatalogResolver(
  params: UseSlashCatalogResolverParams,
): (promptContent: JsonContent) => Promise<JsonContent | null> {
  const queryClient = useQueryClient();
  const { harnessId, hostClient, hostId, workingDirectories } = params;
  const { getLoadedCatalog } = params;
  return useCallback(
    async (promptContent: JsonContent): Promise<JsonContent | null> => {
      const loadedCatalog = getLoadedCatalog();
      if (
        loadedCatalog !== null ||
        !submittedContentNeedsSlashCatalog(promptContent)
      ) {
        return buildSubmittedChatJSONContent(promptContent, loadedCatalog);
      }
      const resolved = await fetchSlashCommandCatalog({
        queryClient,
        client: hostClient,
        hostId,
        harnessId,
        workingDirectories,
      });
      if (resolved === null) return null;
      return buildSubmittedChatJSONContent(promptContent, resolved);
    },
    [
      getLoadedCatalog,
      harnessId,
      hostClient,
      hostId,
      queryClient,
      workingDirectories,
    ],
  );
}
