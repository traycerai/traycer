import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";

/**
 * What a host answers for a sha-addressed read of an object whose whole
 * content is `content`: the text, the requested span as bytes, or a refusal of
 * a download URL, each in the arm the protocol gives that request.
 */
export function answerArtifactObjectRead(
  request: EpicReadArtifactObjectRequest,
  content: string,
  mediaType: string,
): EpicReadArtifactObjectResponse {
  const bytes = new TextEncoder().encode(content);
  switch (request.want.kind) {
    case "text":
      return {
        kind: "text",
        text: content,
        mediaType,
        networkPolicy: "https-only",
      };
    case "range": {
      const span = bytes.slice(
        request.want.offset,
        request.want.offset + request.want.length,
      );
      return {
        kind: "bytes",
        bytesBase64: btoa(String.fromCharCode(...span)),
        offset: request.want.offset,
        totalBytes: bytes.length,
        mediaType,
      };
    }
    case "url":
      return { kind: "unavailable", reason: "not-downloaded" };
  }
}
