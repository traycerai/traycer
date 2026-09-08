import type { ProvidersCopySettingsRequest } from "@traycer/protocol/host/provider-profile-config-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

export function providersListQueryKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    { native: null },
  );
}

/** D13 preview/apply share one request shape (`providersCopySettingsRequestSchema`). */
export type CopySettingsDraft = ProvidersCopySettingsRequest;

/**
 * Keys `providers.previewCopySettings` off the whole draft (source, targets,
 * categories) so a changed selection is a different cache entry rather than a
 * stale review reused across drafts - there is no revision token on the wire
 * (D15) to tell the two apart any other way.
 */
export function providersCopyPreviewQueryKey(
  hostId: string,
  draft: CopySettingsDraft,
) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.previewCopySettings">(
    hostId,
    "providers.previewCopySettings",
    draft,
  );
}
