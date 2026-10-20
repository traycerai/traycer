import { EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES } from "@traycer/protocol/host/epic/artifact-objects";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { ArtifactReadSpan } from "@/lib/sandbox/artifact-serving/artifact-server";

/** Read immutable object bytes through the tab's host, never its working-file path. */
export async function readArtifactBlob(
  object: Pick<ArtifactObjectRef, "sha256" | "byteLength" | "mediaType">,
  readSpan: ArtifactReadSpan,
  signal: AbortSignal,
): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  let offset = 0;
  do {
    signal.throwIfAborted();
    const length = Math.min(
      EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
      Math.max(1, object.byteLength - offset),
    );
    const result = await readSpan(object.sha256, offset, length, signal);
    signal.throwIfAborted();
    if ("unavailable" in result)
      throw new Error(
        "This file is unavailable. Try again when its host is connected.",
      );
    if (
      result.totalBytes !== object.byteLength ||
      result.bytes.length > length ||
      result.bytes.length > object.byteLength - offset ||
      (result.bytes.length === 0 && offset < object.byteLength)
    ) {
      throw new Error("The file download was incomplete. Please retry.");
    }
    parts.push(new Uint8Array(result.bytes).buffer);
    offset += result.bytes.length;
  } while (offset < object.byteLength);
  return new Blob(parts, { type: object.mediaType });
}
