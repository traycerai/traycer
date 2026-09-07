import { Extension } from "@tiptap/core";
import { fencePromotionPlugin } from "./fence-promotion-plugin";

/**
 * Tiptap Extension wrapper around fencePromotionPlugin.
 */
export const FencePromotionExtension = Extension.create({
  name: "fencePromotion",
  addProseMirrorPlugins() {
    return [fencePromotionPlugin()];
  },
});
