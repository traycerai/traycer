/**
 * Where an identity blob's BYTES come from, behind one seam.
 *
 * `agentIdentity.files.readBlob@1.0` serves a blob back out in chunks of at
 * most `AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES`, addressed by the object's
 * `sha256` so a multi-chunk read can never splice across an overwrite. The
 * loop below asks by offset until the host says `final`; `pending` means the
 * host knows the object but has not mirrored its bytes locally yet, which the
 * body renders as "still downloading" rather than as a refusal.
 */
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES } from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { base64ToBytes } from "@/lib/composer/image-base64";

export type IdentityBlobSource =
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The host has the object but its bytes are still on their way. */
  | { readonly kind: "pending"; readonly reason: string }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly mediaType: string;
    };

export interface ResolveIdentityBlobInput {
  readonly identityId: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
}

export const IDENTITY_BLOB_READ_UNAVAILABLE =
  "Preview is unavailable: this host does not serve identity file bytes.";
export const IDENTITY_BLOB_READ_PENDING =
  "Still downloading this file to the host. Try again in a moment.";
export const IDENTITY_BLOB_READ_CORRUPT =
  "The host sent bytes this app could not decode.";

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  pathNotFound: "This file is no longer at that path.",
  unsupportedBodyKind: "This path holds a document, not a file.",
  identityNotFound: "This identity no longer exists on the host.",
  projectionUnavailable: "The host cannot read this identity right now.",
};

export async function resolveIdentityBlobSource(
  client: HostClient<HostRpcRegistry> | null,
  input: ResolveIdentityBlobInput,
): Promise<IdentityBlobSource> {
  if (client === null) {
    return { kind: "unavailable", reason: IDENTITY_BLOB_READ_UNAVAILABLE };
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let received = 0;
  let mediaType = input.mediaType;
  for (;;) {
    const response = await client.request("agentIdentity.files.readBlob", {
      identityId: input.identityId,
      path: input.path,
      sha256: input.sha256,
      offset,
      length: AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES,
    });
    if (response.kind === "pending") {
      return { kind: "pending", reason: IDENTITY_BLOB_READ_PENDING };
    }
    if (response.kind === "refused") {
      return {
        kind: "unavailable",
        reason: REFUSAL_COPY[response.reason] ?? response.detail,
      };
    }
    const chunk = base64ToBytes(response.bytesBase64);
    if (chunk === null) {
      return { kind: "unavailable", reason: IDENTITY_BLOB_READ_CORRUPT };
    }
    mediaType = response.mediaType;
    chunks.push(chunk);
    received += chunk.byteLength;
    offset += chunk.byteLength;
    if (response.final || chunk.byteLength === 0) break;
    // A host that keeps answering non-final chunks past its own stated length
    // is misbehaving; stop rather than read forever.
    if (received >= response.byteLength) break;
  }
  const bytes = new Uint8Array(received);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return { kind: "bytes", bytes, mediaType };
}
