/**
 * Chunked blob upload over `agentIdentity.files.uploadBlob`.
 *
 * One `uploadId` minted per file, chunks of at most
 * `AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES` sent in `sequence` order and awaited
 * one at a time. The policy table runs the method `fifo` keyed on the request
 * params, and awaiting each chunk before dispatching the next is what makes
 * the order a property of this loop rather than of the transport.
 */
import { v4 as uuidv4 } from "uuid";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES } from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { bytesToBase64 } from "@/lib/composer/image-base64";

export type IdentityUploadChunkRequest = RequestOfMethod<
  HostRpcRegistry,
  "agentIdentity.files.uploadBlob"
>;
export type IdentityUploadChunkResponse = ResponseOfMethod<
  HostRpcRegistry,
  "agentIdentity.files.uploadBlob"
>;

export type IdentityUploadOutcome =
  | Extract<IdentityUploadChunkResponse, { kind: "committed" }>
  | Extract<IdentityUploadChunkResponse, { kind: "refused" }>
  /** The host answered `accepted` to the final chunk - a host bug, surfaced. */
  | { readonly kind: "incomplete" };

export interface UploadIdentityBlobInput {
  readonly identityId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string | null;
  readonly executable: boolean;
  readonly sendChunk: (
    request: IdentityUploadChunkRequest,
  ) => Promise<IdentityUploadChunkResponse>;
}

export async function uploadIdentityBlob(
  input: UploadIdentityBlobInput,
): Promise<IdentityUploadOutcome> {
  const { identityId, path, bytes, mediaType, executable, sendChunk } = input;
  const uploadId = uuidv4();
  const chunkCount = Math.max(
    1,
    Math.ceil(bytes.byteLength / AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES),
  );
  for (let sequence = 0; sequence < chunkCount; sequence += 1) {
    const start = sequence * AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES;
    const end = Math.min(
      bytes.byteLength,
      start + AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES,
    );
    const final = sequence === chunkCount - 1;
    const response = await sendChunk({
      identityId,
      path,
      uploadId,
      sequence,
      bytesBase64: bytesToBase64(bytes.subarray(start, end)),
      final,
      mediaType,
      executable,
    });
    if (response.kind === "refused") return response;
    if (response.kind === "committed") return response;
    if (final) return { kind: "incomplete" };
  }
  return { kind: "incomplete" };
}
