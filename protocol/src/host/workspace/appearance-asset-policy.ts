import { assertStaticAppearanceImage } from "./appearance-image-validation";

/**
 * The single appearance-asset admission policy - byte cap, dimension cap and
 * media-type allowlist - shared by the host (`workspace-appearance.ts`) and
 * the gui-app upload path, so the two sides of one upload can never drift on
 * what they accept.
 */
export const MAX_APPEARANCE_ICON_BYTES = 256 * 1024;
export const MAX_APPEARANCE_ICON_EDGE = 256;

export type AppearanceAssetMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export function isAppearanceAssetMediaType(
  value: string,
): value is AppearanceAssetMediaType {
  return (
    value === "image/png" || value === "image/jpeg" || value === "image/webp"
  );
}

/** Throws with a user-facing message when the asset fails admission. */
export function assertAppearanceAssetPolicy(asset: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly width: number | null;
  readonly height: number | null;
}): void {
  if (asset.bytes.length === 0) {
    throw new Error("Appearance icon is empty.");
  }
  if (asset.bytes.length > MAX_APPEARANCE_ICON_BYTES) {
    throw new Error("Appearance icon exceeds its byte limit.");
  }
  if (!isAppearanceAssetMediaType(asset.mediaType)) {
    throw new Error("Appearance images must be PNG, JPEG, or WebP.");
  }
  if (
    asset.width === null ||
    asset.height === null ||
    !Number.isSafeInteger(asset.width) ||
    !Number.isSafeInteger(asset.height) ||
    asset.width < 1 ||
    asset.height < 1 ||
    Math.max(asset.width, asset.height) > MAX_APPEARANCE_ICON_EDGE
  ) {
    throw new Error("Appearance icon exceeds its dimension limit.");
  }
  assertStaticAppearanceImage(asset.bytes, asset.mediaType);
}
