import type { ImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";

export type ComposerContentRenderVariant = "message" | "minimap" | "preview";

export interface ComposerContentRenderContext {
  readonly imageLabelsById: ReadonlyMap<string, ImageAttachmentDisplayLabel>;
  readonly variant: ComposerContentRenderVariant;
}
