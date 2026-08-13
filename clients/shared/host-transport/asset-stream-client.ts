import {
  assetStreamServerFrameSchema,
  MAX_ASSET_BYTES,
  type AssetMediaType,
  type AssetStreamErrorReason,
} from "@traycer/protocol/host/asset-stream-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
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
 * - `"fatal"` - any other fatal close, or a wire-protocol violation: an
 *   unparseable frame, a second `assetHeader`, a chunk arriving before the
 *   header/out of sequence/duplicated, a chunk's payload length not matching
 *   its declared `byteLength`, cumulative bytes exceeding the header's
 *   declared size or `MAX_ASSET_BYTES`, a chunk without its paired binary
 *   payload, or `assetComplete` before `assetHeader`. Any invalid frame ends
 *   the fetch immediately - a strict state machine, not best-effort parsing.
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
 * Unlike the long-lived typed wrappers in this directory
 * (`TerminalStreamClient`, `WorktreeDeleteStreamClient`, ...), this one is a
 * single fetch: nothing more is ever expected once it settles, so it closes
 * its own session on every terminal path (success or failure) instead of
 * leaving an idle subscription - and the host resolver behind it - alive for
 * as long as the caller happens to hold the instance. `close()` is still
 * there and still idempotent, for the caller to cancel BEFORE the fetch
 * settles (unmount, refetch, a superseded request).
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
      if (status === "reconnecting") {
        this.header = null;
        this.chunks = [];
        this.receivedBytes = 0;
        return;
      }
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
      this.fail({ reason: "fatal", message: "received an invalid frame" });
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case "assetHeader": {
        if (this.header !== null) {
          this.fail({
            reason: "fatal",
            message: "assetHeader arrived more than once",
          });
          return;
        }
        this.header = {
          mediaType: frame.mediaType,
          sizeBytes: frame.sizeBytes,
          width: frame.width,
          height: frame.height,
          contentIdentity: frame.contentIdentity,
        };
        this.callbacks.onHeader(this.header);
        return;
      }
      case "assetChunk": {
        const header = this.header;
        if (header === null) {
          this.fail({
            reason: "fatal",
            message: "assetChunk arrived before assetHeader",
          });
          return;
        }
        if (binaryPayload === null) {
          this.fail({
            reason: "fatal",
            message: "assetChunk arrived without its paired binary payload",
          });
          return;
        }
        if (frame.index !== this.chunks.length) {
          this.fail({
            reason: "fatal",
            message: `assetChunk index ${frame.index} out of sequence, expected ${this.chunks.length}`,
          });
          return;
        }
        if (binaryPayload.byteLength !== frame.byteLength) {
          this.fail({
            reason: "fatal",
            message: `assetChunk declared byteLength ${frame.byteLength} but carried ${binaryPayload.byteLength}`,
          });
          return;
        }
        const budget = Math.min(header.sizeBytes, MAX_ASSET_BYTES);
        if (this.receivedBytes + binaryPayload.byteLength > budget) {
          this.fail({
            reason: "fatal",
            message: `assetChunk pushed cumulative bytes past the ${budget}-byte budget`,
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
    this.close();
  }

  private fail(failure: AssetStreamFailure): void {
    this.settled = true;
    this.callbacks.onFailure(failure);
    this.close();
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
