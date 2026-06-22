import type { HostRpcRegistry } from "@/lib/host";

// Any provider override change can flip a provider's availability (enabled
// toggle, selecting a binary that can't launch, or setting/clearing an API key
// like Cursor's), so every provider mutation refreshes the Settings panel,
// both harness selectors, and the generated agent-selection-guide default. The
// guide invalidation recomputes only the generated default; it does not write
// the user's global guide file.
export const PROVIDER_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "providers.list",
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
  "agent.selectionGuide.getGlobal",
  "agent.selectionGuide.getGlobalOnboardingDraft",
];
