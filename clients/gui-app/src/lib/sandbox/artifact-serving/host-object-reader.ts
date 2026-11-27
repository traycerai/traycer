import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { waitUnlessAborted } from "@/lib/wait-unless-aborted";
import type { ArtifactReadSpan } from "./artifact-server";

export type ArtifactObjectRequest = (
  method: "epic.readArtifactObject",
  params: EpicReadArtifactObjectRequest,
  signal: AbortSignal,
) => Promise<EpicReadArtifactObjectResponse>;

// An imperative byte port called by the mount dispatcher outside React.
// Span reads bypass the Query cache.
/** The host may still be copying an authorised object onto the tile's host. */
export function createHostObjectReader(options: {
  readonly request: ArtifactObjectRequest;
  readonly epicId: string;
}): ArtifactReadSpan {
  return async (sha256, offset, length, signal) => {
    let delay = 500;
    for (;;) {
      signal.throwIfAborted();
      let response: EpicReadArtifactObjectResponse;
      try {
        response = await options.request(
          "epic.readArtifactObject",
          {
            epicId: options.epicId,
            sha256,
            want: { kind: "range", offset, length },
          },
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof HostRpcError &&
          error.code === "E_HOST_UNSUPPORTED"
        ) {
          return { unavailable: "missing" };
        }
        throw error;
      }
      signal.throwIfAborted();
      if (response.kind === "unavailable")
        return { unavailable: response.reason };
      if (response.kind === "bytes") {
        if (response.offset !== offset)
          throw new Error("Artifact span offset does not match the request");
        const binary = atob(response.bytesBase64);
        return {
          bytes: Uint8Array.from(binary, (character) =>
            character.charCodeAt(0),
          ),
          totalBytes: response.totalBytes,
          mediaType: response.mediaType,
        };
      }
      if (response.kind !== "downloading")
        throw new Error("Expected artifact object bytes");
      await waitUnlessAborted(delay, signal, "Artifact read aborted");
      delay = Math.min(delay * 2, 2000);
    }
  };
}
