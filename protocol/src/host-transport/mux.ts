import { z } from "zod";
import type {
  ConnectionManifest,
  FatalErrorDetails,
} from "../framework/ws-protocol";
import {
  connectionManifestSchema,
  fatalErrorDetailsSchema,
  schemaVersionSchema,
} from "../framework/ws-protocol";
import type { SchemaVersion } from "../framework/versioned-rpc-types";

/**
 * Shared client<->host mux wire contract carried E2E-encrypted inside the
 * Noise session (remote-host Architecture §3).
 *
 * Layering:
 *   1. Relay frame: client leg `[ciphertext]`, host leg `[sid:u32 BE][ciphertext]`.
 *   2. Noise transport frame: `[v:1][counter:8 BE][AES-GCM ct||tag]`.
 *   3. Mux frame (this module): the Noise plaintext, a binary envelope
 *      `{v,type,streamId,seq,flags}` followed by `[jsonLen][json][binary]`.
 *
 * Transport behavior such as chunking, scheduling, reconnect, and replay
 * windows stays in the client/host transport packages. This module owns only
 * the byte-level contract and payload schemas both peers must share exactly.
 */

/** Mux envelope protocol version carried in every frame's `v` byte. */
export const MUX_PROTOCOL_VERSION = 1;

/**
 * Self-imposed hard cap on one encoded mux plaintext. The relay can carry more,
 * but remote-host v1 keeps frames under 1 MiB for interactivity and fails fast
 * locally before encryption/send.
 */
export const MAX_MUX_FRAME_BYTES = 1024 * 1024;

const HEADER_LEN = 15;

// -----------------------------------------------------------------------------
// Frame envelope
// -----------------------------------------------------------------------------

export const MuxFrameType = {
  /** Session open: `{bearer, manifest, authz}` (streamId 0). */
  OPEN: 1,
  /** Host ack of the open: `{manifest, capabilities}` (streamId 0). */
  OPEN_ACK: 2,
  /** Unary request: `{requestId, method, schemaVersion, params, idempotencyKey}`. */
  REQUEST: 3,
  /** Unary response: `{requestId, method, result|error}`. */
  RESPONSE: 4,
  /** Stream subscribe: `{method, schemaVersion, params}`. */
  SUBSCRIBE: 5,
  /** Application stream frame: json = the stream envelope, binary = its payload. */
  STREAM_FRAME: 6,
  /** Logical stream close intent: `{reason}`. */
  CLOSE: 7,
  /** Stream or session fatal error: `{details}` (streamId 0 = whole session). */
  FATAL: 8,
  /** Flow-control credit grant: `{credits}` (streamId 0 = session bulk window). */
  CREDIT: 9,
  /** Host-standing evidence (R4-D2 peer-enforcement): `{standingUntil}`. */
  REAUTH_NOTICE: 10,
  /** RESERVED (R4-E3): resume-ticket message type. Not built in v1. */
  RESUME: 11,
  /** In-place bearer rotation: `{bearer}` on streamId 0. */
  CREDENTIAL_UPDATE: 12,
} as const;

export type MuxFrameTypeValue =
  (typeof MuxFrameType)[keyof typeof MuxFrameType];

/** QoS class, fixed per logical stream at creation. */
export const QosClass = {
  /** Keystrokes, live output, unary/control: preempts bulk, not credit-gated. */
  INTERACTIVE: 0,
  /** Bulk transfers: chunked at 64 KiB locally, credit-gated, yields to interactive. */
  BULK: 1,
} as const;

export type QosClassValue = (typeof QosClass)[keyof typeof QosClass];

/** Envelope flag bits (the `flags` byte). */
export const MuxFlags = {
  /** The frame carries a binary payload section after the json section. */
  HAS_BINARY: 0b0000_0001,
  /** The frame is bulk-class (interactive when unset). */
  BULK: 0b0000_0010,
  /** The frame is one chunk of a multi-chunk logical message. */
  CHUNKED: 0b0000_0100,
  /** The final chunk of a multi-chunk logical message (set with CHUNKED). */
  CHUNK_LAST: 0b0000_1000,
} as const;

/** The stream id reserved for session-level control frames. */
export const SESSION_CONTROL_STREAM_ID = 0;

export interface MuxFrame {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly seq: number;
  readonly qos: QosClassValue;
  readonly chunked: boolean;
  readonly chunkLast: boolean;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

export interface EncodeMuxFrameInput {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly seq: number;
  readonly qos: QosClassValue;
  readonly chunked: boolean;
  readonly chunkLast: boolean;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

// -----------------------------------------------------------------------------
// Session-control payloads
// -----------------------------------------------------------------------------

/** Reserved versioned authorization slot (R4-D1). v1 sends `null`. */
export type ReservedAuthzSlot = {
  readonly v: number;
  readonly grant: string;
} | null;

/** The session `open` frame (R4-A2 bridging-never-identity). */
export interface SessionOpenPayload {
  readonly muxVersion: number;
  readonly bearer: string;
  readonly manifest: SessionManifests;
  readonly authz: ReservedAuthzSlot;
  /** Reserved resume descriptor (R4-E3). Always null in v1. */
  readonly resume: null;
}

export interface SessionManifests {
  readonly rpc: ConnectionManifest;
  readonly stream: ConnectionManifest;
}

/** Host ack of `open`: its own combined manifest + additive capabilities. */
export interface SessionOpenAckPayload {
  readonly manifest: SessionManifests;
  readonly capabilities: readonly string[];
}

/** Host-standing evidence payload (REAUTH_NOTICE, R4-D2). */
export interface ReauthNoticePayload {
  readonly standingUntil: number;
}

// -----------------------------------------------------------------------------
// Logical-stream payloads
// -----------------------------------------------------------------------------

export interface UnaryRequestPayload {
  readonly requestId: string;
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
  /**
   * Reserved for later per-method dedup. v1 has no host dedup machinery, so the
   * authoritative wire value is `null`; non-null values fail schema validation.
   */
  readonly idempotencyKey: null;
}

export interface WireRpcErrorDetails {
  readonly code: string;
  readonly message: string;
}

export interface UnaryResponsePayload {
  readonly requestId: string;
  readonly method: string;
  readonly result: unknown;
  readonly error: WireRpcErrorDetails | null;
}

export interface StreamSubscribePayload {
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
}

export interface StreamClosePayload {
  readonly reason: string;
}

export interface FatalPayload {
  readonly details: FatalErrorDetails;
}

export interface CreditPayload {
  readonly credits: number;
}

export interface CredentialUpdatePayload {
  readonly bearer: string;
}

// -----------------------------------------------------------------------------
// Zod schemas
// -----------------------------------------------------------------------------

const sessionManifestsSchema: z.ZodType<SessionManifests> = z.object({
  rpc: connectionManifestSchema,
  stream: connectionManifestSchema,
});

const reservedAuthzSlotSchema: z.ZodType<ReservedAuthzSlot> = z
  .object({ v: z.number(), grant: z.string() })
  .nullable();

export const sessionOpenPayloadSchema: z.ZodType<SessionOpenPayload> = z.object(
  {
    muxVersion: z.number().int(),
    bearer: z.string(),
    manifest: sessionManifestsSchema,
    authz: reservedAuthzSlotSchema,
    resume: z.null(),
  },
);

export const sessionOpenAckPayloadSchema: z.ZodType<SessionOpenAckPayload> =
  z.object({
    manifest: sessionManifestsSchema,
    capabilities: z.array(z.string()),
  });

export const unaryRequestPayloadSchema: z.ZodType<UnaryRequestPayload> =
  z.object({
    requestId: z.string(),
    method: z.string(),
    schemaVersion: schemaVersionSchema,
    params: z.unknown(),
    idempotencyKey: z.null(),
  });

export const unaryResponsePayloadSchema: z.ZodType<UnaryResponsePayload> =
  z.object({
    requestId: z.string(),
    method: z.string(),
    result: z.unknown(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .nullable(),
  });

export const streamSubscribePayloadSchema: z.ZodType<StreamSubscribePayload> =
  z.object({
    method: z.string(),
    schemaVersion: schemaVersionSchema,
    params: z.unknown(),
  });

export const streamClosePayloadSchema: z.ZodType<StreamClosePayload> = z.object(
  {
    reason: z.string(),
  },
);

export const fatalPayloadSchema: z.ZodType<FatalPayload> = z.object({
  details: fatalErrorDetailsSchema,
});

export const creditPayloadSchema: z.ZodType<CreditPayload> = z.object({
  credits: z.number().int().nonnegative(),
});

export const reauthNoticePayloadSchema: z.ZodType<ReauthNoticePayload> =
  z.object({
    standingUntil: z.number().int().nonnegative(),
  });

export const credentialUpdatePayloadSchema: z.ZodType<CredentialUpdatePayload> =
  z.object({ bearer: z.string() });

/** Capability tag advertised in `openAck.capabilities` for bearer rotation. */
export const SESSION_CAPABILITY_CREDENTIAL_UPDATE = "credentialUpdate";

/** Current mux protocol version. */
export const CURRENT_MUX_VERSION = MUX_PROTOCOL_VERSION;

/** Fixed Noise-NK prologue, mixed into the handshake hash by both endpoints. */
export const NOISE_PROLOGUE: Uint8Array = new TextEncoder().encode(
  "traycer-remote-host/mux/v1",
);

// -----------------------------------------------------------------------------
// Binary mux codec
// -----------------------------------------------------------------------------

/** Thrown when an inbound mux frame is structurally invalid (fail-closed). */
export class MuxFrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuxFrameDecodeError";
  }
}

/** Thrown before send when a plaintext mux frame would exceed the local cap. */
export class MuxFrameSizeError extends Error {
  constructor(byteLength: number) {
    super(
      `mux frame exceeds ${MAX_MUX_FRAME_BYTES}-byte cap: ${byteLength} bytes`,
    );
    this.name = "MuxFrameSizeError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodedMuxFrameSize(input: EncodeMuxFrameInput): number {
  const jsonBytes = encodeJsonSection(input.json);
  const binaryLength = input.binary === null ? 0 : input.binary.length;
  return HEADER_LEN + jsonBytes.length + binaryLength;
}

export function assertMuxFrameFits(input: EncodeMuxFrameInput): void {
  assertMuxFrameByteLength(encodedMuxFrameSize(input));
}

export function encodeMuxFrame(input: EncodeMuxFrameInput): Uint8Array {
  const jsonBytes = encodeJsonSection(input.json);
  const binary = input.binary === null ? new Uint8Array(0) : input.binary;
  const byteLength = HEADER_LEN + jsonBytes.length + binary.length;
  assertMuxFrameByteLength(byteLength);

  let flags = 0;
  if (input.binary !== null) {
    flags |= MuxFlags.HAS_BINARY;
  }
  if (input.qos === QosClass.BULK) {
    flags |= MuxFlags.BULK;
  }
  if (input.chunked) {
    flags |= MuxFlags.CHUNKED;
  }
  if (input.chunkLast) {
    flags |= MuxFlags.CHUNK_LAST;
  }

  const out = new Uint8Array(byteLength);
  const view = new DataView(out.buffer);
  out[0] = MUX_PROTOCOL_VERSION;
  out[1] = input.type;
  view.setUint32(2, input.streamId);
  view.setUint32(6, input.seq);
  out[10] = flags;
  view.setUint32(11, jsonBytes.length);
  out.set(jsonBytes, HEADER_LEN);
  out.set(binary, HEADER_LEN + jsonBytes.length);
  return out;
}

const KNOWN_MUX_FRAME_TYPES: ReadonlySet<number> = new Set(
  Object.values(MuxFrameType),
);

export function decodeMuxFrame(bytes: Uint8Array): MuxFrame {
  if (bytes.length > MAX_MUX_FRAME_BYTES) {
    throw new MuxFrameDecodeError(
      `mux frame exceeds ${MAX_MUX_FRAME_BYTES}-byte cap: ${bytes.length} bytes`,
    );
  }
  if (bytes.length < HEADER_LEN) {
    throw new MuxFrameDecodeError(
      `mux frame too short: ${bytes.length} < ${HEADER_LEN}`,
    );
  }
  const version = bytes[0];
  if (version !== MUX_PROTOCOL_VERSION) {
    throw new MuxFrameDecodeError(`unsupported mux version: ${version}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeByte = bytes[1];
  if (!KNOWN_MUX_FRAME_TYPES.has(typeByte)) {
    throw new MuxFrameDecodeError(`unknown mux frame type: ${typeByte}`);
  }
  const type = typeByte as MuxFrameTypeValue;
  const streamId = view.getUint32(2);
  const seq = view.getUint32(6);
  const flags = bytes[10];
  const jsonLen = view.getUint32(11);

  const jsonStart = HEADER_LEN;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonEnd > bytes.length) {
    throw new MuxFrameDecodeError(
      `mux json length ${jsonLen} exceeds frame (${bytes.length - jsonStart} available)`,
    );
  }

  const hasBinary = (flags & MuxFlags.HAS_BINARY) !== 0;
  const json =
    jsonLen === 0 ? null : parseJsonSection(bytes, jsonStart, jsonEnd);
  const binary = hasBinary ? bytes.slice(jsonEnd) : null;

  return {
    type,
    streamId,
    seq,
    qos: (flags & MuxFlags.BULK) !== 0 ? QosClass.BULK : QosClass.INTERACTIVE,
    chunked: (flags & MuxFlags.CHUNKED) !== 0,
    chunkLast: (flags & MuxFlags.CHUNK_LAST) !== 0,
    json,
    binary,
  };
}

function encodeJsonSection(json: Record<string, unknown> | null): Uint8Array {
  return json === null
    ? new Uint8Array(0)
    : textEncoder.encode(JSON.stringify(json));
}

function assertMuxFrameByteLength(byteLength: number): void {
  if (byteLength > MAX_MUX_FRAME_BYTES) {
    throw new MuxFrameSizeError(byteLength);
  }
}

function parseJsonSection(
  bytes: Uint8Array,
  start: number,
  end: number,
): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes.subarray(start, end));
  } catch {
    throw new MuxFrameDecodeError("mux json section is not valid utf-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new MuxFrameDecodeError("mux json section is not valid json");
  }
  if (!isRecord(parsed)) {
    throw new MuxFrameDecodeError("mux json section is not an object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
