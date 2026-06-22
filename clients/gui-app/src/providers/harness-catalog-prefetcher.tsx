import { useGuiHarnessCatalog } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * Renderer-side warmup for the GUI harness catalog. The host already
 * prewarms availability and provider servers; this keeps TanStack Query's
 * model catalog warm before the user opens a new-chat picker.
 */
export function HarnessCatalogPrefetcher() {
  useGuiHarnessCatalog(null, { enabled: true, subscribed: true });
  return null;
}
