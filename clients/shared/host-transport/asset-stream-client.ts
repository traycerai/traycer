import {
  assetStreamServerFrameSchema,
  type AssetMediaType,
  type AssetStreamErrorReason,
} from "@traycer/protocol/host/asset-stream-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";
import type { ParamsOf } from "./ws-stream-client";

/**
 * The two stream methods that share the `assetHeader`/`assetChunk`/
 * `assetComplete`/`assetError` frame shape - see
 * `asset-stream-schemas.ts`'s file-level doc.
 */
export type AssetStreamMethod = "workspace.streamAsset" | "git.streamFileAsset";

export interface AssetStreamHeader {
  readonly mediaType: AssetMediaType;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly contentIdentity: string;
}

/**
 * Why a fetch did not produce usable bytes.
 *
 * - `"unsupported-method"` - the host predates this stream method; the
 *   mirror compatibility check rejected the subscribe before anything was
 *   sent. Old-host behaviour: falls back to today's placeholder.
 * - `"fatal"` - any other fatal close, or a wire-protocol violation (a
 *   chunk without its paired binary payload, `assetComplete` before
 *   `assetHeader`).
 * - `"interrupted"` - the session closed (caller or transport drop) before
 *   `assetComplete`, with no fatal detail to explain why.
 * - `"length-mismatch"` - every chunk arrived but the assembled byte count
 *   does not match the header's `sizeBytes`.
 * - every other value is a host-reported `assetError.reason`, forwarded
 *   verbatim.
 *
 * Every value maps to the SAME uniform placeholder fallback UI
 * (image-preview decision log, decision #14) - the distinction exists so
 * tests and logs can tell the paths apart, not for divergent UI.
 */
export type AssetStreamFailureReason =
  | "unsupported-method"
  | "fatal"
  | "interrupted"
  | "length-mismatch"
  | AssetStreamErrorReason;

export interface AssetStreamFailure {
  readonly reason: AssetStreamFailureReason;
  readonly message: string;
}

export interface AssetStreamCallbacks {
  /**
   * Fires once, as soon as the header frame arrives - before bytes finish -
   * so a consumer can render a skeleton at the declared aspect ratio
   * (decision #12).
   */
  readonly onHeader: (header: AssetStreamHeader) => void;
  /** Terminal success: every chunk assembled and the length verified. */
  readonly onReady: (header: AssetStreamHeader, bytes: Uint8Array) => void;
  /** Terminal failure - no `onReady` will follow for this fetch. */
  readonly onFailure: (failure: AssetStreamFailure) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface AssetStreamClientOptions<Method extends AssetStreamMethod> {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly method: Method;
  readonly params: ParamsOf<HostStreamRpcRegistry, Method>;
  readonly callbacks: AssetStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `workspace.streamAsset` /
 * `git.streamFileAsset`. One instance fetches exactly one asset: it opens
 * the session, assembles `assetChunk` payloads into a single `Uint8Array` in
 * arrival order, verifies the assembled length against the header's
 * `sizeBytes`, and settles exactly once via `onReady` or `onFailure`.
 *
 * The caller owns the session's lifetime - mirrors every other typed stream
 * wrapper in this directory (`TerminalStreamClient`,
 * `WorktreeDeleteStreamClient`, ...), none of which auto-close on their own
 * terminal frame. Call `close()` on unmount or refetch.
 */
export class AssetStreamClient<
  Method extends AssetStreamMethod = AssetStreamMethod,
> {
  private readonly session: IStreamSession;
  private readonly callbacks: AssetStreamCallbacks;
  private readonly method: Method;
  private closed: boolean;
  private settled: boolean;
  private header: AssetStreamHeader | null;
  private chunks: Uint8Array[];
  private receivedBytes: number;

  constructor(options: AssetStreamClientOptions<Method>) {
    this.callbacks = options.callbacks;
    this.method = options.method;
    this.closed = false;
    this.settled = false;
    this.header = null;
    this.chunks = [];
    this.receivedBytes = 0;

    this.session = options.wsStreamClient.subscribe(
      options.method,
      options.params,
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
      if (status === "closed") {
        this.handleClosed(reason);
      }
    });
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.settled) {
      return;
    }
    const parsed = assetStreamServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case "assetHeader": {
        this.header = {
          mediaType: frame.mediaType,
          sizeBytes: frame.sizeBytes,
          width: frame.width,
          height: frame.height,
          contentIdentity: frame.contentIdentity,
        };
        this.chunks = [];
        this.receivedBytes = 0;
        this.callbacks.onHeader(this.header);
        return;
      }
      case "assetChunk": {
        if (binaryPayload === null) {
          // The local `/stream` WS transport enforces this pairing itself
          // (a hard socket teardown on violation, before this handler is
          // ever called - see `StreamSession.handleTextFrame`). The remote
          // mux transport carries the binary section as an optional part of
          // the same frame, so a buggy or malicious host CAN send
          // `hasBinaryPayload: true` with no binary section - this guards
          // that path, mirroring `TerminalStreamClient`'s identical check on
          // `binarySnapshot`/`binaryData`.
          this.fail({
            reason: "fatal",
            message: "assetChunk arrived without its paired binary payload",
          });
          return;
        }
        this.chunks.push(binaryPayload);
        this.receivedBytes += binaryPayload.byteLength;
        return;
      }
      case "assetComplete": {
        const header = this.header;
        if (header === null) {
          this.fail({
            reason: "fatal",
            message: "assetComplete arrived before assetHeader",
          });
          return;
        }
        if (this.receivedBytes !== header.sizeBytes) {
          this.fail({
            reason: "length-mismatch",
            message: `received ${this.receivedBytes} bytes, expected ${header.sizeBytes}`,
          });
          return;
        }
        this.succeed(header, concatChunks(this.chunks, this.receivedBytes));
        return;
      }
      case "assetError": {
        this.fail({ reason: frame.reason, message: frame.error });
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }

  private handleClosed(reason: StreamCloseReason | null): void {
    if (this.settled || this.closed) {
      // Already resolved, or the caller requested this close itself
      // (cancellation/unmount/refetch) - not a failure to report.
      return;
    }
    if (reason === null || reason.kind !== "fatalError") {
      this.fail({
        reason: "interrupted",
        message: "stream closed before assetComplete",
      });
      return;
    }
    const unsupported = reason.details.incompatibleMethods?.some(
      (entry) => entry.method === this.method,
    );
    this.fail({
      reason: unsupported === true ? "unsupported-method" : "fatal",
      message: reason.details.reason,
    });
  }

  private succeed(header: AssetStreamHeader, bytes: Uint8Array): void {
    this.settled = true;
    this.callbacks.onReady(header, bytes);
  }

  private fail(failure: AssetStreamFailure): void {
    this.settled = true;
    this.callbacks.onFailure(failure);
  }
}

function concatChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
