import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// Stream a file through sha-256 and return the lowercase hex digest.
// Used to fingerprint the staged host archive before unpacking and
// to record `archiveSha256` on the install record.
export function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}
