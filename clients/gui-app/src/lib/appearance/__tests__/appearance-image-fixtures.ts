/**
 * Genuine, minimal (1x1) PNG/JPEG/WebP byte sequences for appearance image
 * tests. `validateAppearanceImage` runs the real `image-size` header parser
 * after its own magic-byte sniff, so a fixture that only satisfies the sniff
 * (as the prompt-stash suite's structure-only builders do) fails `imageSize`
 * and every test using it. These decode to real 1x1 images under both.
 */

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function realPng1x1(): Uint8Array<ArrayBuffer> {
  return bytesFromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
}

export function realJpeg1x1(): Uint8Array<ArrayBuffer> {
  return bytesFromBase64(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  );
}

export function realWebp1x1(): Uint8Array<ArrayBuffer> {
  return bytesFromBase64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");
}

/** A second, genuinely distinct valid 1x1 PNG - a white pixel vs. `realPng1x1()`'s. */
export function realPng1x1Alt(): Uint8Array<ArrayBuffer> {
  return bytesFromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  );
}

/**
 * A structurally valid PNG whose IHDR declares an arbitrary width/height,
 * with no real pixel data - `image-size` (like every conformant PNG reader)
 * takes dimensions from IHDR alone, so this is enough to drive the
 * megapixel-limit check without encoding gigantic real pixel buffers.
 */
export function pngWithDeclaredDimensions(
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const typeAndData = new Uint8Array(4 + ihdr.length);
  typeAndData.set([0x49, 0x48, 0x44, 0x52], 0); // "IHDR"
  typeAndData.set(ihdr, 4);
  const chunk = new Uint8Array(4 + typeAndData.length + 4);
  new DataView(chunk.buffer).setUint32(0, ihdr.length);
  chunk.set(typeAndData, 4);
  // CRC is left as zero: `image-size` reads IHDR positionally and never
  // verifies it, and this fixture never reaches a real decoder.
  const out = new Uint8Array(signature.length + chunk.length);
  out.set(signature, 0);
  out.set(chunk, signature.length);
  return out;
}

/**
 * `realPng1x1()` with an `acTL` chunk spliced in right after IHDR - the APNG
 * animation-control chunk `assertStaticAppearanceImage` rejects. The CRC is
 * left as zero: that check never validates chunk CRCs, only chunk types.
 */
export function animatedPng1x1(): Uint8Array<ArrayBuffer> {
  const base = realPng1x1();
  const ihdrEnd = 8 + 25; // signature + (4 len + 4 type + 13 data + 4 crc)
  const payloadLength = 8;
  const chunk = new Uint8Array(4 + 4 + payloadLength + 4);
  new DataView(chunk.buffer).setUint32(0, payloadLength);
  chunk.set([0x61, 0x63, 0x54, 0x4c], 4); // "acTL"
  const out = new Uint8Array(base.length + chunk.length);
  out.set(base.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(base.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/**
 * Bytes that exceed a byte budget by construction - `validateAppearanceAssetBlob`
 * rejects on `blob.size` before it ever sniffs content, so these need no real
 * image structure at all.
 */
export function oversizedBytes(minBytes: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(minBytes + 1);
}
