import type { Decoration } from "@tiptap/pm/view";

import type { ImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { numberValue, stringValue } from "@/lib/composer/tiptap-json-content";

export function imageAttachmentLabelDecorationSpec(
  label: ImageAttachmentDisplayLabel,
): {
  readonly composerImageReferenceNumber: number;
  readonly composerImageBadgeLabel: string;
  readonly composerImageInlineLabel: string;
  readonly composerImageReferenceLabel: string;
  readonly composerImageTitle: string;
  readonly composerImageAriaLabel: string;
} {
  return {
    composerImageReferenceNumber: label.referenceNumber,
    composerImageBadgeLabel: label.badgeLabel,
    composerImageInlineLabel: label.inlineLabel,
    composerImageReferenceLabel: label.referenceLabel,
    composerImageTitle: label.title,
    composerImageAriaLabel: label.ariaLabel,
  };
}

export function imageAttachmentDisplayLabelFromDecorations(
  decorations: readonly Decoration[],
): ImageAttachmentDisplayLabel | null {
  return (
    decorations
      .map((decoration) =>
        imageAttachmentDisplayLabelFromDecorationSpec(decoration.spec),
      )
      .find(isImageAttachmentDisplayLabel) ?? null
  );
}

function imageAttachmentDisplayLabelFromDecorationSpec(
  spec: unknown,
): ImageAttachmentDisplayLabel | null {
  if (typeof spec !== "object" || spec === null) return null;
  const referenceNumber = numberValue(
    Reflect.get(spec, "composerImageReferenceNumber"),
  );
  const badgeLabel = stringValue(Reflect.get(spec, "composerImageBadgeLabel"));
  const inlineLabel = stringValue(
    Reflect.get(spec, "composerImageInlineLabel"),
  );
  const referenceLabel = stringValue(
    Reflect.get(spec, "composerImageReferenceLabel"),
  );
  const title = stringValue(Reflect.get(spec, "composerImageTitle"));
  const ariaLabel = stringValue(Reflect.get(spec, "composerImageAriaLabel"));
  if (
    referenceNumber === null ||
    badgeLabel === null ||
    inlineLabel === null ||
    referenceLabel === null ||
    title === null ||
    ariaLabel === null
  ) {
    return null;
  }
  return {
    referenceNumber,
    badgeLabel,
    inlineLabel,
    referenceLabel,
    title,
    ariaLabel,
  };
}

function isImageAttachmentDisplayLabel(
  value: ImageAttachmentDisplayLabel | null,
): value is ImageAttachmentDisplayLabel {
  return value !== null;
}
