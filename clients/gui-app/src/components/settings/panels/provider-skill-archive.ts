import { bytesToBase64Async } from "@/lib/composer/image-base64";

const TAR_BLOCK_BYTES = 512;
const OCTAL_REGULAR_FILE_MODE = "0000644";

/** A NUL-terminated octal header field of `width` bytes. */
function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** One regular file's ustar header, its bytes and their padding. */
function tarFile(name: string, content: Uint8Array): Uint8Array {
  const paddedBody =
    Math.ceil(content.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  const entry = new Uint8Array(TAR_BLOCK_BYTES + paddedBody);
  const encoder = new TextEncoder();
  const write = (text: string, offset: number): void => {
    entry.set(encoder.encode(text), offset);
  };
  write(name, 0);
  write(`${OCTAL_REGULAR_FILE_MODE}\0`, 100);
  write(octalField(0, 8), 108);
  write(octalField(0, 8), 116);
  write(octalField(content.byteLength, 12), 124);
  write(octalField(0, 12), 136);
  // The checksum is summed over its own field read as spaces.
  write("        ", 148);
  write("0", 156);
  write("ustar\u000000", 257);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    sum += entry[index] ?? 0;
  }
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  entry.set(content, TAR_BLOCK_BYTES);
  return entry;
}

/**
 * A written skill as `environment.configuration.skills.upload` takes one: a
 * folder holding `SKILL.md`, as a gzipped tar in standard base64.
 */
export async function skillArchiveBase64(markdown: string): Promise<string> {
  const { gzipSync } = await import("fflate");
  const file = tarFile("SKILL.md", new TextEncoder().encode(markdown));
  // Two zero blocks end the archive.
  const tar = new Uint8Array(file.byteLength + 2 * TAR_BLOCK_BYTES);
  tar.set(file);
  return bytesToBase64Async(gzipSync(tar));
}
