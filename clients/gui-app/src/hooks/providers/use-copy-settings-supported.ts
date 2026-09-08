import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

/**
 * Whether `hostId` can serve D13's copy flow at all. Both methods are
 * optional/non-floor (D21); an older host handshakes without either, so this
 * fails closed like every other `useHostSupportsMethod` gate. Shared by the
 * switcher's "Copy settings…" entry (`ProviderDetail`) and `CopySettingsPage`'s
 * own render guard, so the two never answer the question differently.
 */
export function useCopySettingsSupported(hostId: string | null): boolean {
  const supportsPreview = useHostSupportsMethod(
    hostId,
    "providers.previewCopySettings",
  );
  const supportsApply = useHostSupportsMethod(
    hostId,
    "providers.applyCopySettings",
  );
  return supportsPreview && supportsApply;
}
