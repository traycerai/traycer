import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactOriginParts,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { parseArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";

export interface ServedFile {
  readonly status: number;
  readonly mediaType: string;
  readonly base64: string;
}

export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const SPAN_BYTES = 4 * 1024 * 1024;

export class FixtureArtifactBridge implements SandboxArtifactBridge {
  readonly policySource = null;
  private readonly handlers = new Set<
    (request: SandboxArtifactRequest) => void
  >();
  private readonly replies = new Map<
    string,
    (reply: SandboxArtifactReply) => void
  >();
  private requestCounter = 0;

  artifactOrigin({ artifactId, mountId }: SandboxArtifactOriginParts): string {
    return `https://artifact-${artifactId}--${mountId}.traycer-artifact.invalid`;
  }
  register(): Promise<void> {
    return Promise.resolve();
  }
  unregister(): Promise<void> {
    return Promise.resolve();
  }
  onRequest(handler: (request: SandboxArtifactRequest) => void): Disposable {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }
  onCancel(_handler: (cancel: SandboxArtifactCancel) => void): Disposable {
    return { dispose: () => undefined };
  }
  respond(reply: SandboxArtifactReply): Promise<void> {
    this.replies.get(reply.requestId)?.(reply);
    this.replies.delete(reply.requestId);
    return Promise.resolve();
  }

  private ask(mountId: string, path: string, offset: number) {
    const requestId = `chat-card-${String((this.requestCounter += 1))}`;
    return new Promise<SandboxArtifactReply>((resolve) => {
      this.replies.set(requestId, resolve);
      for (const handler of this.handlers)
        handler({ requestId, mountId, path, offset, length: SPAN_BYTES });
    });
  }

  async serve(url: string): Promise<ServedFile> {
    const address = parseArtifactAddress(url);
    if (address === null)
      return { status: 404, mediaType: "text/plain", base64: "" };
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const reply = await this.ask(address.mountId, address.path, offset);
      if (reply.kind === "unavailable")
        return { status: reply.status, mediaType: "text/plain", base64: "" };
      chunks.push(reply.bytes);
      offset += reply.bytes.length;
      if (offset >= reply.totalBytes || reply.bytes.length === 0) {
        const whole = new Uint8Array(offset);
        let at = 0;
        for (const chunk of chunks) {
          whole.set(chunk, at);
          at += chunk.length;
        }
        return {
          status: 200,
          mediaType: reply.mediaType,
          base64: base64Of(whole),
        };
      }
    }
  }
}
