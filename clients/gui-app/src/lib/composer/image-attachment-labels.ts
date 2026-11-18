export interface ImageAttachmentLabelSource {
  readonly id: string;
  readonly fileName: string;
}

export interface ImageAttachmentDisplayLabel {
  readonly referenceNumber: number;
  readonly badgeLabel: string;
  readonly inlineLabel: string;
  readonly referenceLabel: string;
  readonly title: string;
  readonly ariaLabel: string;
}

export function buildImageAttachmentDisplayLabels(
  sources: ReadonlyArray<ImageAttachmentLabelSource>,
): ReadonlyMap<string, ImageAttachmentDisplayLabel> {
  const labels = new Map<string, ImageAttachmentDisplayLabel>();
  sources.forEach((source, index) => {
    const fileName = imageFileNameForDisplay(source.fileName);
    const referenceNumber = index + 1;
    const referenceLabel = `Image#${referenceNumber}`;
    labels.set(source.id, {
      referenceNumber,
      badgeLabel: String(referenceNumber),
      inlineLabel: referenceLabel,
      referenceLabel,
      title: `${referenceLabel}: ${fileName}`,
      ariaLabel: `${referenceLabel}: ${fileName}`,
    });
  });
  return labels;
}

export function fallbackImageAttachmentDisplayLabel(
  source: ImageAttachmentLabelSource,
): ImageAttachmentDisplayLabel {
  const label = buildImageAttachmentDisplayLabels([source]).get(source.id);
  if (label !== undefined) return label;
  return {
    referenceNumber: 1,
    badgeLabel: "1",
    inlineLabel: "Image#1",
    referenceLabel: "Image#1",
    title: "Image#1: image",
    ariaLabel: "Image#1: image",
  };
}

function imageFileNameForDisplay(fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed.length === 0) return "image";
  return trimmed.split(/[\\/]/).at(-1) ?? trimmed;
}
