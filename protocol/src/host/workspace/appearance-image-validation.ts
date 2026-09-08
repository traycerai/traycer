/** Static-only admission also rejects animation control chunks with zero frames. */
export function assertStaticAppearanceImage(
  bytes: Uint8Array,
  mediaType: "image/png" | "image/jpeg" | "image/webp",
): void {
  if (mediaType === "image/jpeg") return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = mediaType === "image/png";
  let offset = png ? 8 : 12;
  while (offset < bytes.length) {
    if (offset + (png ? 12 : 8) > bytes.length)
      throw new Error("Image has a truncated chunk.");
    const size = png
      ? view.getUint32(offset)
      : view.getUint32(offset + 4, true);
    const typeOffset = offset + (png ? 4 : 0);
    const kind = String.fromCharCode(
      ...bytes.subarray(typeOffset, typeOffset + 4).map((byte) => byte & 0x7f),
    );
    const next = offset + size + (png ? 12 : 8 + (size % 2));
    if (next > bytes.length) throw new Error("Image has a truncated chunk.");
    if (
      ["acTL", "fcTL", "fdAT", "ANIM", "ANMF"].includes(kind) ||
      (!png && kind === "VP8X" && size > 0 && (bytes[offset + 8] & 2) !== 0)
    ) {
      throw new Error(
        "Appearance images must be normalized to a static image.",
      );
    }
    if (png && kind === "IEND") {
      if (next !== bytes.length)
        throw new Error("Unexpected data after PNG image.");
      return;
    }
    offset = next;
  }
  if (png) throw new Error("PNG image is missing its end chunk.");
}
