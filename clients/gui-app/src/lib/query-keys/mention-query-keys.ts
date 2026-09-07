import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { MentionGithubCatalogRequest } from "@traycer/protocol/host/mention-schemas";

import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/** Named alias for the composer's cache-only PR/issue catalog read. */
export const mentionQueryKeys = {
  githubCatalog: (hostId: string | null, params: MentionGithubCatalogRequest) =>
    hostQueryKeys.method<HostRpcRegistry, "mention.githubCatalog">(
      hostId,
      "mention.githubCatalog",
      params,
    ),
} as const;
