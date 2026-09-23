import { TRAYCER_WIREFRAME_TAG } from "./const";
import { rehypePromoteFence } from "./rehype-promote-fence";

export function rehypeCustomWireframe() {
  return rehypePromoteFence("wireframe", TRAYCER_WIREFRAME_TAG);
}
