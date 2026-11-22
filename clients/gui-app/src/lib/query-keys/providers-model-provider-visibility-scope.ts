import type { MutationScope } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

const UNRESOLVED_HOST = "unresolved-host";

/**
 * The queue for showing or hiding OpenCode model providers, keyed by host AND
 * harness because the resource is one provider's entry in
 * `provider-overrides.json` - the shape `providerNativeSubagentsWriteScope`
 * uses, for its reason: two rapid flips sit in one queue, so the host applies
 * them in the order they were made.
 */
export function providerModelProviderVisibilityWriteScope(
  hostId: string | null,
  harnessId: GuiHarnessId,
): MutationScope {
  return {
    id: `providers.setModelProviderHidden:${hostId ?? UNRESOLVED_HOST}:${harnessId}`,
  };
}
