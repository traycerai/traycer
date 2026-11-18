import type { Disposable } from "./uri-callback";

/**
 * How many object bytes one host read asks for, and how large a span a
 * native shell's protocol handler asks the renderer for.
 *
 * Each read is one `epic.readArtifactObject` unary whose reply carries the
 * bytes as base64 JSON, and on a remote host that reply crosses the relay
 * under the 30 s unary deadline. At the host's 4 MiB range ceiling a reply
 * was 5.6 MB on the wire: nothing played until all of it had arrived, and
 * below ~190 KB/s nothing ever did (a 5 MB recording timed out four times
 * in a row on a degraded link). At 512 KiB a reply is ~700 KB, the first
 * bytes reach the player eight times sooner, and a link only has to sustain
 * ~25 KB/s for a read to land. Smaller still would spend a relay round trip
 * per few hundred KB on a healthy link.
 */
export const ARTIFACT_OBJECT_SPAN_BYTES = 512 * 1024;

export interface SandboxArtifactRequest {
  readonly requestId: string;
  readonly mountId: string;
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}

export interface SandboxArtifactCancel {
  readonly requestId: string;
}

export type SandboxArtifactReply =
  | {
      readonly requestId: string;
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly offset: number;
      readonly totalBytes: number;
      readonly mediaType: string;
    }
  | {
      readonly requestId: string;
      readonly kind: "unavailable";
      readonly reason: string;
      readonly status: 404 | 503;
    };

export interface SandboxArtifactOriginParts {
  readonly artifactId: string;
  readonly mountId: string;
}

/** Supplies bounded file spans to the shell's sandbox protocol handler. */
export interface SandboxArtifactBridge {
  /** An extra CSP scheme source, including its colon; HTTPS needs none. */
  readonly policySource: string | null;
  artifactOrigin(parts: SandboxArtifactOriginParts): string;
  register(mountId: string): Promise<void>;
  unregister(mountId: string): Promise<void>;
  onRequest(handler: (request: SandboxArtifactRequest) => void): Disposable;
  onCancel(handler: (cancel: SandboxArtifactCancel) => void): Disposable;
  respond(reply: SandboxArtifactReply): Promise<void>;
}
