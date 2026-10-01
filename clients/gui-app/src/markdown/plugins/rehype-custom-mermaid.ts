import { TRAYCER_MERMAID_TAG } from "./const";
import { rehypePromoteFence } from "./rehype-promote-fence";

export function rehypeCustomMermaid() {
  return rehypePromoteFence("mermaid", TRAYCER_MERMAID_TAG);
}
