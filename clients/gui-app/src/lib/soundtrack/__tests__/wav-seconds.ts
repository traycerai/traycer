import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** How long a shipped chime lasts, read from its RIFF header. */
export function chimeSeconds(name: string): number {
  // Vitest runs from the project root.
  const bytes = readFileSync(
    resolve("src/lib/notifications/chimes", `${name}.wav`),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteRate = view.getUint32(28, true);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${name}.wav has no data chunk`);
}
