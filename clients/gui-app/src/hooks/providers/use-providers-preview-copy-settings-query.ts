import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { CopySettingsDraft } from "@/lib/query-keys/providers-query-keys";

/**
 * D13 review step: `providers.previewCopySettings` for the committed draft
 * (source, targets, categories). A read, not a mutation - preview has no
 * side effect - so a plain query, keyed off the whole draft via
 * `useHostQuery`'s own params-derived key: a changed draft (Back, then a
 * different target/category set) is therefore a different cache entry
 * rather than a stale review reused across drafts. Never call this with a
 * draft the caller has not committed to (empty `targets`/`categories`
 * fails the wire schema's `.min(1)`).
 */
export function useProvidersPreviewCopySettings(
  client: HostClient<HostRpcRegistry> | null,
  draft: CopySettingsDraft,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.previewCopySettings">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "providers.previewCopySettings">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.previewCopySettings",
    params: draft,
    options: null,
  });
}
