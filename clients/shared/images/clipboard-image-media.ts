import {
  supportedImageMediaTypes,
  type SupportedImageMediaType,
} from "@traycer/protocol/persistence/epic/images";

export type ClipboardImageMediaType = Exclude<
  SupportedImageMediaType,
  "image/svg+xml"
>;

// Electron's native clipboard path accepts decoded raster images. SVG stays
// downloadable, but copying it would require a deliberate rasterization step.
export const clipboardImageMediaTypes: ReadonlyArray<ClipboardImageMediaType> =
  supportedImageMediaTypes.filter(
    (mediaType): mediaType is ClipboardImageMediaType =>
      mediaType !== "image/svg+xml",
  );

const clipboardImageMediaTypeSet: ReadonlySet<string> = new Set(
  clipboardImageMediaTypes,
);

export function isClipboardImageMediaType(
  value: string | null,
): value is ClipboardImageMediaType {
  return value !== null && clipboardImageMediaTypeSet.has(value);
}
