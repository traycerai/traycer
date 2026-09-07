import type { HostRpcRegistry } from "@/lib/host";

// Shared invalidation catalog for provider mutations. Direct writes through `commitAuthoritativeProvidersList` skip `providers.list` itself (just written).
export const PROVIDER_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "providers.list",
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
  "agent.selectionGuide.getGlobal",
  "agent.selectionGuide.getGlobalOnboardingDraft",
];
