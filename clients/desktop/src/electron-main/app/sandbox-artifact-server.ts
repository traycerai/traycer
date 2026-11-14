import { randomUUID } from "node:crypto";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import {
  ARTIFACT_OBJECT_SPAN_BYTES,
  type SandboxArtifactReply,
  type SandboxArtifactCancel,
  type SandboxArtifactRequest,
} from "../../ipc-contracts/sandbox-artifact-types";
import {
  parseSandboxArtifactUrl,
  SANDBOX_CONTENT_SECURITY_POLICY,
} from "./sandbox-protocol";

interface ArtifactMount {
  readonly windowId: string;
  /**
   * The artifact this mount serves, taken from its first request. That
   * request is the frame's own navigation, issued by the renderer that
   * registered the mount, so a page cannot claim another artifact's mount.
   */
  artifactId: string | null;
}

interface SpanWaiter {
  readonly windowId: string;
  readonly mountId: string;
  readonly resolve: (reply: SandboxArtifactReply) => void;
  readonly cancel: (reason: string) => void;
}

type SendToWindow = (
  windowId: string,
  channel: string,
  request: SandboxArtifactRequest | SandboxArtifactCancel,
) => boolean;

function responseHeaders(mediaType: string): Headers {
  return new Headers({
    "Content-Type": mediaType,
    "Content-Security-Policy": SANDBOX_CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
}

function errorResponse(status: number, reason: string): Response {
  return new Response(reason.slice(0, 256), {
    status,
    headers: responseHeaders("text/plain; charset=utf-8"),
  });
}

/** Main only transports spans; the owning renderer resolves files through its host. */
export class SandboxArtifactServer {
  private readonly mounts = new Map<string, ArtifactMount>();
  private readonly waiters = new Map<string, SpanWaiter>();

  constructor(private readonly sendToWindow: SendToWindow) {}

  register(mountId: string, windowId: string): void {
    if (!/^[a-z0-9]+$/.test(mountId))
      throw new Error("Invalid artifact mount id");
    const mount = this.mounts.get(mountId);
    if (mount === undefined) {
      this.mounts.set(mountId, { windowId, artifactId: null });
    } else if (mount.windowId !== windowId) {
      throw new Error("Artifact mount belongs to another window");
    }
  }

  ownsMount(mountId: string, windowId: string): boolean {
    return this.mounts.get(mountId)?.windowId === windowId;
  }

  unregister(mountId: string): void {
    this.mounts.delete(mountId);
    this.failWaiters((waiter) => waiter.mountId === mountId);
  }

  dropWindow(windowId: string): void {
    for (const [mountId, mount] of this.mounts) {
      if (mount.windowId === windowId) this.mounts.delete(mountId);
    }
    this.failWaiters((waiter) => waiter.windowId === windowId);
  }

  retainWindows(windowIds: ReadonlySet<string>): void {
    for (const { windowId } of this.mounts.values()) {
      if (!windowIds.has(windowId)) this.dropWindow(windowId);
    }
  }

  dispose(): void {
    this.mounts.clear();
    this.failWaiters(() => true);
  }

  respond(reply: SandboxArtifactReply, windowId: string): void {
    const waiter = this.waiters.get(reply.requestId);
    // A reload or timeout can leave a late reply; another window cannot claim it.
    if (waiter === undefined || waiter.windowId !== windowId) return;
    waiter.resolve(reply);
  }

  private failWaiters(matches: (waiter: SpanWaiter) => boolean): void {
    for (const waiter of this.waiters.values()) {
      if (matches(waiter)) waiter.cancel("Artifact window unavailable");
    }
  }

  private requestSpan(
    mountId: string,
    windowId: string,
    path: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<SandboxArtifactReply> {
    const requestId = randomUUID();
    const unavailable = (reason: string): SandboxArtifactReply => ({
      requestId,
      kind: "unavailable",
      status: 503,
      reason,
    });
    if (!this.ownsMount(mountId, windowId) || signal.aborted) {
      return Promise.resolve(unavailable("Artifact window unavailable"));
    }
    return new Promise((resolve) => {
      const finish = (reply: SandboxArtifactReply): void => {
        if (!this.waiters.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(reply);
      };
      const cancel = (reason: string): void => {
        if (!this.waiters.has(requestId)) return;
        // Settle first: a racing reply cannot revive this request during cancellation.
        finish(unavailable(reason));
        try {
          this.sendToWindow(windowId, RunnerHostEvent.sandboxArtifactCancel, {
            requestId,
          });
        } catch {
          // A renderer that is gone cannot have a read left to cancel.
        }
      };
      const abort = (): void => cancel("Artifact request cancelled");
      // A renderer may first need to download a file from another host.
      const timer = setTimeout(
        () => cancel("Artifact request timed out"),
        5 * 60 * 1000,
      );
      this.waiters.set(requestId, {
        windowId,
        mountId,
        resolve: finish,
        cancel,
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (
          !this.sendToWindow(windowId, RunnerHostEvent.sandboxArtifactRequest, {
            requestId,
            mountId,
            path,
            offset,
            length,
          })
        ) {
          finish(unavailable("Artifact window unavailable"));
        }
      } catch {
        finish(unavailable("Artifact window unavailable"));
      }
    });
  }

  /**
   * The window that serves a mount under an artifact's site: `null` for an
   * unknown mount, and for one whose own artifact is another.
   */
  private windowServing(artifactId: string, mountId: string): string | null {
    const mount = this.mounts.get(mountId);
    if (mount === undefined) return null;
    mount.artifactId ??= artifactId;
    return mount.artifactId === artifactId ? mount.windowId : null;
  }

  async fetch(request: Request): Promise<Response> {
    if (!URL.canParse(request.url))
      return errorResponse(400, "Invalid artifact URL");
    const address = parseSandboxArtifactUrl(request.url);
    if (address === null) return errorResponse(404, "Artifact not found");
    const path = address.pathname;
    if (path === null) return errorResponse(400, "Invalid artifact path");
    const { mountId } = address;
    const windowId = this.windowServing(address.artifactId, mountId);
    if (windowId === null)
      return errorResponse(404, "Artifact mount not found");

    const range = request.headers.get("Range");
    let offset = 0;
    // The last byte the caller asked for; `null` is "to the end of the file".
    let last: number | null = null;
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match === null) return errorResponse(416, "Invalid artifact range");
      offset = Number(match[1]);
      last = match[2] === "" ? null : Number(match[2]);
      if (
        !Number.isSafeInteger(offset) ||
        (last !== null && (!Number.isSafeInteger(last) || last < offset))
      )
        return errorResponse(416, "Invalid artifact range");
    }
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    const spanLength = (position: number): number =>
      last === null
        ? ARTIFACT_OBJECT_SPAN_BYTES
        : Math.min(ARTIFACT_OBJECT_SPAN_BYTES, last - position + 1);
    const first = await this.requestSpan(
      mountId,
      windowId,
      path,
      offset,
      spanLength(offset),
      signal,
    );
    if (first.kind === "unavailable")
      return errorResponse(first.status, first.reason);
    if (range !== null && offset >= first.totalBytes) {
      const response = errorResponse(416, "Artifact range outside file");
      response.headers.set("Content-Range", `bytes */${first.totalBytes}`);
      return response;
    }
    if (!validSpan(first, offset, spanLength(offset)))
      return errorResponse(503, "Invalid artifact span");
    const totalBytes = first.totalBytes;
    const mediaType = first.mediaType;
    // A range reply covers everything asked for, span by span: the media
    // loader opens a recording with `bytes=N-` and treats a 206 that stops
    // short of the file's end as a failed source, not as an invitation to ask
    // for the rest.
    const end = Math.min(last ?? totalBytes - 1, totalBytes - 1);
    const headers = responseHeaders(mediaType);
    headers.set("Content-Length", String(end - offset + 1));
    if (range !== null)
      headers.set("Content-Range", `bytes ${offset}-${end}/${totalBytes}`);
    let buffered: Uint8Array | null = first.bytes;
    let position = offset;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (buffered !== null) {
            const bytes = buffered;
            buffered = null;
            position += bytes.byteLength;
            if (bytes.byteLength > 0) controller.enqueue(bytes);
          } else if (position <= end) {
            const length = spanLength(position);
            const next = await this.requestSpan(
              mountId,
              windowId,
              path,
              position,
              length,
              signal,
            );
            if (
              next.kind !== "bytes" ||
              next.totalBytes !== totalBytes ||
              next.mediaType !== mediaType ||
              !validSpan(next, position, length)
            ) {
              // Headers have already left; an interrupted stream must fail, never look complete.
              controller.error(new Error("Artifact stream unavailable"));
              return;
            }
            position += next.bytes.byteLength;
            controller.enqueue(next.bytes);
          }
          if (position > end) controller.close();
        },
        cancel: () => cancellation.abort(),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: range === null ? 200 : 206, headers });
  }
}

function validSpan(
  reply: Extract<SandboxArtifactReply, { kind: "bytes" }>,
  offset: number,
  length: number,
): boolean {
  return (
    reply.offset === offset &&
    Number.isSafeInteger(reply.totalBytes) &&
    reply.totalBytes >= offset &&
    reply.bytes.byteLength === Math.min(length, reply.totalBytes - offset)
  );
}
