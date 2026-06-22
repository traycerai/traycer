import { Extension } from "@tiptap/core";
import { fencePromotionPlugin } from "./fence-promotion-plugin";

/**
 * Tiptap extension host for `fencePromotionPlugin`. Wrapping the raw
 * ProseMirror plugin as an `Extension` is the idiomatic way to register
 * it alongside the rest of the artifact bundle - consumers pass it to
 * `useEditor({ extensions })` just like any other Tiptap extension.
 */
export const FencePromotionExtension = Extension.create({
  name: "fencePromotion",
  addProseMirrorPlugins() {
    return [fencePromotionPlugin()];
  },
});
