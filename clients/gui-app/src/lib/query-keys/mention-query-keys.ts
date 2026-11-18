import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { MentionGithubCatalogRequest } from "@traycer/protocol/host/mention-schemas";

import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Named alias for the composer's cache-only PR/issue catalog read.
 *
 * It exists because two lanes write the SAME slot: the `refresh: "none"` query
 * is what the menu renders from, while the stale follow-up (`"auto"`) and the
 * refresh button (`"manual"`) are mutations whose responses are folded back
 * into it. If either lane rebuilt this key by hand they could drift, and the
 * fresher rows would land in a slot nothing reads. Delegates to the generic
 * `method` builder so the key SHAPE stays defined in one place.
 */
export const mentionQueryKeys = {
  githubCatalog: (hostId: string | null, params: MentionGithubCatalogRequest) =>
    hostQueryKeys.method<HostRpcRegistry, "mention.githubCatalog">(
      hostId,
      "mention.githubCatalog",
      params,
    ),
} as const;
