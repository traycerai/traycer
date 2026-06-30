import { useGuiHarnessCatalog } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostCompatibility } from "@/lib/host";

/**
 * Renderer-side warmup for the GUI harness catalog. The host already
 * prewarms availability and provider servers; this keeps TanStack Query's
 * model catalog warm before the user opens a new-chat picker.
 */
export function HarnessCatalogPrefetcher() {
  const compatibility = useHostCompatibility();
  const active = compatibility.status === "compatible";
  useGuiHarnessCatalog(null, { enabled: active, subscribed: active });
  return null;
}
