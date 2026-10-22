import type {
  ArtifactManifest,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { isArtifactPath } from "@/lib/sandbox/artifact-serving/artifact-address";

// The native save route needs the completed archive in memory. Bound the
// uncompressed bytes as well as the file count before asking for any objects.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_FILES = 4096;
const READ_BYTES = 256 * 1024;

function validateManifest(manifest: ArtifactManifest): void {
  let bytes = 0;
  let files = 0;
  for (const path in manifest.files) {
    if (!Object.hasOwn(manifest.files, path)) continue;
    files += 1;
    if (files > MAX_BUNDLE_FILES) {
      throw new Error("This artifact has too many files to download as a ZIP.");
    }
    const entry = manifest.files[path];
    if (!isArtifactPath(path) || path.includes(":")) {
      throw new Error(
        "This artifact contains a file path that cannot be exported.",
      );
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error("This artifact contains an invalid file size.");
    }
    bytes += entry.byteLength;
    if (bytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        "This artifact is too large to download. ZIP downloads support up to 64 MB of files.",
      );
    }
  }
  if (files === 0) throw new Error("This artifact has no files to download.");
}

/** Raw captured bytes only: no injected viewer scripts or rewritten URLs. */
export async function createHtmlArtifactZip(input: {
  readonly manifest: ArtifactManifest;
  readonly readSpan: ArtifactReadSpan;
  readonly signal: AbortSignal;
}): Promise<Blob> {
  validateManifest(input.manifest);
  input.signal.throwIfAborted();
  const { Zip, ZipPassThrough } = await import("fflate");
  const chunks: Blob[] = [];
  const output = { complete: false };
  const zip = new Zip((error, bytes, final) => {
    if (error !== null) throw error;
    chunks.push(new Blob([Uint8Array.from(bytes)]));
    output.complete = final;
  });
  try {
    for (const [path, entry] of Object.entries(input.manifest.files)) {
      input.signal.throwIfAborted();
      const file = new ZipPassThrough(path);
      zip.add(file);
      let offset = 0;
      // Read even an empty file to prove the object is available. A partial
      // bundle is never offered as a successful download.
      do {
        const length = Math.max(
          1,
          Math.min(READ_BYTES, entry.byteLength - offset),
        );
        const result = await input.readSpan(
          entry.sha256,
          offset,
          length,
          input.signal,
        );
        input.signal.throwIfAborted();
        if ("unavailable" in result) {
          throw new Error(
            "A file in this version is unavailable. The ZIP was not downloaded.",
          );
        }
        if (
          result.totalBytes !== entry.byteLength ||
          result.bytes.byteLength !==
            Math.min(length, entry.byteLength - offset)
        ) {
          throw new Error(
            "A file in this version could not be read completely. Try downloading again.",
          );
        }
        offset += result.bytes.byteLength;
        file.push(result.bytes, offset === entry.byteLength);
      } while (offset < entry.byteLength);
    }
    zip.end();
    if (!output.complete) throw new Error("The ZIP could not be completed.");
    return new Blob(chunks, { type: "application/zip" });
  } finally {
    zip.terminate();
  }
}

export function htmlArtifactZipName(title: string): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/g, "");
  return `artifact-${stem || "bundle"}.zip`;
}
