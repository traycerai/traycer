import type { Disposable } from "./uri-callback";

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
