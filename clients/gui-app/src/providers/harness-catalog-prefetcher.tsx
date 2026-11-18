import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostCompatibility } from "@/lib/host";

/**
 * Renderer-side warmup for harness AVAILABILITY only. Model lists load on
 * first use: the landing composer and picker issue `agent.gui.listModels` for
 * the selected (and, once browsed, that) harness. An all-harnesses fill at
 * boot was one RPC per available provider - 24 calls / ~133 KB over the
 * relay on a staging account - and a cold `listModels` can spawn a provider
 * server.
 *
 * `listHarnesses` still belongs here: first paint of the composer rail needs
 * availability, and that unary is one call.
 */
export function HarnessCatalogPrefetcher() {
  const compatibility = useHostCompatibility();
  const active = compatibility.status === "compatible";
  useGuiHarnessesQuery({
    enabled: active,
    subscribed: active,
  });
  return null;
}
