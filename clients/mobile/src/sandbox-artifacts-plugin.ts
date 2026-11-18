import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactOriginParts,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** Capacitor transports JSON. Keep each decoded span bounded to 4 MiB. */
export type NativeArtifactReply =
  | (Omit<Extract<SandboxArtifactReply, { kind: "bytes" }>, "bytes"> & {
      readonly base64: string;
    })
  | Extract<SandboxArtifactReply, { kind: "unavailable" }>;

export interface SandboxArtifactsPlugin {
  /** Native acknowledgement after listener registration has run on its queue. */
  ready(): Promise<void>;
  respond(reply: NativeArtifactReply): Promise<void>;
  addListener(
    event: "request",
    handler: (request: SandboxArtifactRequest) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "cancel",
    handler: (cancel: SandboxArtifactCancel) => void,
  ): Promise<PluginListenerHandle>;
}

export const SandboxArtifacts =
  registerPlugin<SandboxArtifactsPlugin>("SandboxArtifacts");

/** Native listeners live with the runner, so an unmounted URL gets an answer. */
export class MobileSandboxArtifacts implements SandboxArtifactBridge {
  readonly policySource: string | null;
  private readonly mounts = new Set<string>();
  private readonly requests = new Map<string, string>();
  private readonly requestHandlers = new Set<
    (request: SandboxArtifactRequest) => void
  >();
  private readonly cancelHandlers = new Set<
    (cancel: SandboxArtifactCancel) => void
  >();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly plugin: SandboxArtifactsPlugin,
    private readonly platform: "ios" | "android",
  ) {
    this.policySource = platform === "android" ? null : "traycer-artifact:";
  }

  artifactOrigin({ artifactId, mountId }: SandboxArtifactOriginParts): string {
    return this.platform === "android"
      ? `https://artifact-${artifactId}--${mountId}.traycer-artifact.invalid`
      : `traycer-artifact://artifact-${artifactId}--${mountId}`;
  }

  async register(mountId: string): Promise<void> {
    if (!/^[a-z0-9]+$/.test(mountId))
      throw new Error("Invalid artifact mount id");
    this.mounts.add(mountId);
    try {
      await this.ensureListeners();
    } catch (error) {
      this.mounts.delete(mountId);
      throw error;
    }
  }

  async unregister(mountId: string): Promise<void> {
    this.mounts.delete(mountId);
    const replies: Promise<void>[] = [];
    for (const [requestId, owner] of this.requests) {
      if (owner !== mountId) continue;
      this.requests.delete(requestId);
      replies.push(
        this.plugin.respond({
          requestId,
          kind: "unavailable",
          status: 404,
          reason: "unmounted",
        }),
      );
    }
    await Promise.all(replies);
  }

  onRequest(handler: (request: SandboxArtifactRequest) => void): Disposable {
    this.requestHandlers.add(handler);
    return {
      dispose: () => {
        this.requestHandlers.delete(handler);
      },
    };
  }

  onCancel(handler: (cancel: SandboxArtifactCancel) => void): Disposable {
    this.cancelHandlers.add(handler);
    return {
      dispose: () => {
        this.cancelHandlers.delete(handler);
      },
    };
  }

  async respond(reply: SandboxArtifactReply): Promise<void> {
    if (!this.requests.delete(reply.requestId)) return;
    if (reply.kind === "unavailable") {
      await this.plugin.respond(reply);
      return;
    }
    if (reply.bytes.byteLength > 4 * 1024 * 1024) {
      await this.plugin.respond({
        requestId: reply.requestId,
        kind: "unavailable",
        status: 503,
        reason: "Invalid artifact span",
      });
      return;
    }
    // Avoid spreading an entire span into a function's argument list.
    const chunks: string[] = [];
    for (let i = 0; i < reply.bytes.byteLength; i += 8192) {
      chunks.push(String.fromCharCode(...reply.bytes.subarray(i, i + 8192)));
    }
    const { bytes: _bytes, ...metadata } = reply;
    await this.plugin.respond({ ...metadata, base64: btoa(chunks.join("")) });
  }

  private ensureListeners(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = this.attachListeners().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async attachListeners(): Promise<void> {
    const requests = await this.plugin.addListener("request", (request) => {
      if (
        !this.mounts.has(request.mountId) ||
        this.requestHandlers.size === 0
      ) {
        void this.plugin
          .respond({
            requestId: request.requestId,
            kind: "unavailable",
            status: 404,
            reason: "unmounted",
          })
          .catch(() => {});
        return;
      }
      this.requests.set(request.requestId, request.mountId);
      for (const handler of this.requestHandlers) handler(request);
    });
    let cancellations: PluginListenerHandle | null = null;
    try {
      cancellations = await this.plugin.addListener("cancel", (cancel) => {
        if (!this.requests.delete(cancel.requestId)) return;
        for (const handler of this.cancelHandlers) handler(cancel);
      });
      // Capacitor's addListener promise acknowledges a callback id, not native
      // registration. Navigation waits for a real reply behind both registrations.
      await this.plugin.ready();
    } catch (error) {
      await Promise.allSettled([requests.remove(), cancellations?.remove()]);
      throw error;
    }
  }
}
