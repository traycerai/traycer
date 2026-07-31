import type { ProviderNativeErrorCode } from "@traycer/protocol/host/provider-native-schemas";

const NATIVE_ERROR_COPY: Readonly<Record<ProviderNativeErrorCode, string>> = {
  duplicate_name: "A server with this name already exists in this scope.",
  unsupported_scope: "This action is not supported for the selected scope.",
  unsupported_action: "This action is not supported for this provider.",
  no_change_detected:
    "No change was applied. The provider config already matched the request.",
  external_drift:
    "The provider config changed externally. Refresh and try again.",
  store_version_unsupported:
    "This provider store version is not supported for writes.",
  rollback_failed:
    "The change failed and automatic rollback could not restore the previous config.",
};

export function nativeErrorMessage(
  code: ProviderNativeErrorCode,
  detail: string | null,
): string {
  if (detail !== null && detail.trim().length > 0) return detail.trim();
  return NATIVE_ERROR_COPY[code];
}
