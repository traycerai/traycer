import { useGuiHarnessCatalog } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostCompatibility } from "@/lib/host";

/**
 * Only `"all-harnesses"` mount. Fans out on the app-wide default host. User-facing surfaces read `"cached-only"`.
 */
export function HarnessCatalogPrefetcher() {
  const compatibility = useHostCompatibility();
  const active = compatibility.status === "compatible";
  useGuiHarnessCatalog(null, {
    enabled: active,
    subscribed: active,
    modelsFetch: "all-harnesses",
  });
  return null;
}
