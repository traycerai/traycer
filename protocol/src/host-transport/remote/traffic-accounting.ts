import type { MuxFrame } from "@traycer/protocol/host-transport/mux";

/** Only these fields may leave a request for the diagnostic snapshot. */
export interface RemoteTrafficStreamSnapshot {
  readonly streamId: number;
  readonly method: string;
  readonly kind: "rpc" | "stream" | "control";
  readonly epic: string | null;
  readonly chat: string | null;
  readonly firstMs: number | null;
  readonly lastMs: number | null;
  readonly ciphertextBytes: number;
  readonly muxBytes: number;
  readonly frames: number;
  readonly compressedFrames: number;
  readonly incomplete: boolean;
  /** Connection drops this stream was still open across. */
  readonly reconnects: number;
}

export interface RemoteTrafficSnapshot {
  readonly startedAt: number;
  readonly receivedBytes: number;
  readonly receivedFrames: number;
  readonly relayTextBytes: number;
  readonly relayTextFrames: number;
  readonly noiseHandshakeBytes: number;
  readonly noiseHandshakeFrames: number;
  readonly unclassifiedBinaryBytes: number;
  readonly unclassifiedBinaryFrames: number;
  /** New streams after the row cap remain in the unclassified residual. */
  readonly truncatedStreamRegistrations: number;
  /**
   * Relay WebSocket legs that opened and then dropped into recovery. A dial
   * that never opens adds nothing, and a caller close adds nothing.
   */
  readonly reconnects: number;
  readonly streams: ReadonlyArray<RemoteTrafficStreamSnapshot>;
}

interface TrafficRow {
  streamId: number;
  method: string;
  kind: "rpc" | "stream" | "control";
  epic: string | null;
  chat: string | null;
  firstMs: number | null;
  lastMs: number | null;
  ciphertextBytes: number;
  muxBytes: number;
  frames: number;
  compressedFrames: number;
  incomplete: boolean;
  reconnects: number;
  pendingChunk: boolean;
  active: boolean;
}

const SAFE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHOD = /^[A-Za-z][A-Za-z0-9.-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MAX_TRAFFIC_ROWS = 1024;

function safeMethod(value: string): string {
  return SAFE_METHOD.test(value) &&
    !SHA256_HEX.test(value) &&
    !SAFE_ID.test(value)
    ? value
    : "unclassified-method";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

/** This is a strict allowlist, never a serialization or generic object walk. */
function safeScope(params: unknown): {
  epic: string | null;
  chat: string | null;
} {
  const top = recordOf(params);
  const identity = recordOf(top?.identity);
  return {
    epic:
      safeId(top?.epicId) ?? safeId(top?.taskId) ?? safeId(identity?.taskId),
    chat: safeId(top?.chatId) ?? safeId(identity?.chatId),
  };
}

/**
 * In-memory, opt-in wire accounting. Nothing in the normal inbound path creates
 * a row or snapshot: callers guard every method on a nullable instance.
 */
export class RemoteTrafficAccounting {
  readonly startedAt = Date.now();
  private readonly rows = new Map<number, TrafficRow>();
  private receivedBytes = 0;
  private receivedFrames = 0;
  private relayTextBytes = 0;
  private relayTextFrames = 0;
  private noiseHandshakeBytes = 0;
  private noiseHandshakeFrames = 0;
  private unclassifiedBinaryBytes = 0;
  private unclassifiedBinaryFrames = 0;
  private truncatedStreamRegistrations = 0;
  private reconnects = 0;

  register(
    streamId: number,
    method: string,
    kind: "rpc" | "stream",
    params: unknown,
  ): void {
    const scope = safeScope(params);
    const existing = this.rows.get(streamId);
    if (existing !== undefined) {
      existing.epic ??= scope.epic;
      existing.chat ??= scope.chat;
      existing.active = true;
      return;
    }
    if (this.rows.size >= MAX_TRAFFIC_ROWS) {
      this.truncatedStreamRegistrations += 1;
      return;
    }
    this.rows.set(streamId, {
      streamId,
      method: safeMethod(method),
      kind,
      epic: scope.epic,
      chat: scope.chat,
      firstMs: null,
      lastMs: null,
      ciphertextBytes: 0,
      muxBytes: 0,
      frames: 0,
      compressedFrames: 0,
      incomplete: false,
      reconnects: 0,
      pendingChunk: false,
      active: true,
    });
  }

  receiveBinary(bytes: number): number {
    this.receivedBytes += bytes;
    this.receivedFrames += 1;
    this.unclassifiedBinaryBytes += bytes;
    this.unclassifiedBinaryFrames += 1;
    return Date.now() - this.startedAt;
  }

  receiveText(bytes: number): void {
    this.receivedBytes += bytes;
    this.receivedFrames += 1;
    this.relayTextBytes += bytes;
    this.relayTextFrames += 1;
  }

  classifyHandshake(bytes: number): void {
    this.unclassifiedBinaryBytes -= bytes;
    this.unclassifiedBinaryFrames -= 1;
    this.noiseHandshakeBytes += bytes;
    this.noiseHandshakeFrames += 1;
  }

  classifyMux(
    frame: MuxFrame,
    ciphertextBytes: number,
    muxBytes: number,
    receivedAtMs: number,
  ): void {
    let row = this.rows.get(frame.streamId);
    if (frame.streamId === 0 && row === undefined) {
      this.register(0, "session-control", "stream", null);
      row = this.rows.get(0);
      if (row !== undefined) row.kind = "control";
    }
    if (row === undefined) return;
    this.unclassifiedBinaryBytes -= ciphertextBytes;
    this.unclassifiedBinaryFrames -= 1;
    row.firstMs ??= receivedAtMs;
    row.lastMs = receivedAtMs;
    row.ciphertextBytes += ciphertextBytes;
    row.muxBytes += muxBytes;
    row.frames += 1;
    if (frame.compressed) row.compressedFrames += 1;
    if (frame.chunked) row.pendingChunk = !frame.chunkLast;
  }

  end(streamId: number, incomplete: boolean): void {
    const row = this.rows.get(streamId);
    if (row === undefined) return;
    row.active = false;
    row.incomplete ||= incomplete || row.pendingChunk;
    row.pendingChunk = false;
  }

  connectionLost(): void {
    this.reconnects += 1;
    for (const row of this.rows.values()) {
      if (!row.active || row.streamId === 0) continue;
      row.reconnects += 1;
      row.incomplete ||= row.pendingChunk || row.kind === "rpc";
      row.pendingChunk = false;
    }
  }

  snapshot(): RemoteTrafficSnapshot {
    return {
      startedAt: this.startedAt,
      receivedBytes: this.receivedBytes,
      receivedFrames: this.receivedFrames,
      relayTextBytes: this.relayTextBytes,
      relayTextFrames: this.relayTextFrames,
      noiseHandshakeBytes: this.noiseHandshakeBytes,
      noiseHandshakeFrames: this.noiseHandshakeFrames,
      unclassifiedBinaryBytes: this.unclassifiedBinaryBytes,
      unclassifiedBinaryFrames: this.unclassifiedBinaryFrames,
      truncatedStreamRegistrations: this.truncatedStreamRegistrations,
      reconnects: this.reconnects,
      streams: [...this.rows.values()].map((row) => ({
        streamId: row.streamId,
        method: row.method,
        kind: row.kind,
        epic: row.epic,
        chat: row.chat,
        firstMs: row.firstMs,
        lastMs: row.lastMs,
        ciphertextBytes: row.ciphertextBytes,
        muxBytes: row.muxBytes,
        frames: row.frames,
        compressedFrames: row.compressedFrames,
        incomplete:
          row.incomplete ||
          row.pendingChunk ||
          (row.active && row.kind === "rpc" && row.frames > 0),
        reconnects: row.reconnects,
      })),
    };
  }
}
