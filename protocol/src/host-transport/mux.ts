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
 * Hard cap on one mux frame as the RELAY sees it (`workers/relay-do`'s
 * `MAX_FRAME_BYTES` — a larger frame closes the whole session). The relay
 * measures the Noise CIPHERTEXT, so the plaintext budget senders must obey is
 * {@link MAX_MUX_FRAME_PLAINTEXT_BYTES}, this minus the Noise overhead.
 * Inbound decode still tolerates up to this full size.
 */
export const MAX_MUX_FRAME_BYTES = 1024 * 1024;

/**
 * Bytes the Noise transport adds around one mux plaintext:
 * `[v:1][counter:8 BE]` header + the 16-byte AES-GCM tag (see
 * `crypto/noise/session.ts`). Budgeted here so a frame at the plaintext cap
 * can never produce a ciphertext the relay's own 1 MiB cap kills.
 */
export const NOISE_TRANSPORT_OVERHEAD_BYTES = 9 + 16;

/**
 * The relay's host uplink is one multiplexed WebSocket, so every frame on it
 * rides wrapped as `[sid:u32 BE][noise ciphertext]` (host→relay stamped by
 * `session-fan-out`'s host-leg framing; relay→host stamped by the relay).
 * The relay applies its 1 MiB `MAX_FRAME_BYTES` to the WHOLE WebSocket
 * message BEFORE stripping the prefix, so the prefix eats into the frame
 * budget and must be subtracted from the plaintext cap. Budgeted for both
 * directions (the client leg carries bare ciphertext, but a symmetric cap
 * keeps one number true everywhere).
 */
export const RELAY_HOST_LEG_PREFIX_BYTES = 4;

/**
 * The sender-side cap on one encoded mux plaintext
 * (relay cap − Noise overhead − host-leg demux prefix).
 */
export const MAX_MUX_FRAME_PLAINTEXT_BYTES =
  MAX_MUX_FRAME_BYTES -
  NOISE_TRANSPORT_OVERHEAD_BYTES -
  RELAY_HOST_LEG_PREFIX_BYTES;

/**
 * Receiver-side robustness bound on one LOGICAL mux message (the reassembled
 * chunk-sequence body). Sized to the platform, not to expected content: V8's
 * `MAX_STRING_LENGTH` sits 24 bytes UNDER this, so a JSON payload can never
 * quite reach it and enforcement on the sender is necessarily
 * stringify-in-a-try (`RangeError`) followed by a byte check — see
 * `chunking.ts`. Droppable once windowed/paged transfers ship.
 */
export const MAX_MUX_MESSAGE_BYTES = 512 * 1024 * 1024;

/** Fixed mux frame header length: `[v:1][type:1][streamId:4][seq:4][flags:1][jsonLen:4]`. */
export const MUX_FRAME_HEADER_LEN = 15;

const HEADER_LEN = MUX_FRAME_HEADER_LEN;

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
  /**
   * The first chunk of a multi-chunk logical message (set with CHUNKED).
   * Load-bearing for reassembly: every data frame now carries its payload as
   * opaque body bytes (`chunking.ts`), so no in-band field distinguishes a
   * sequence start from a stray continuation — this flag is that distinction,
   * and without it an orphaned continuation would silently seed a fresh
   * accumulator and surface later as an undiagnosable body-decode failure.
   */
  CHUNK_FIRST: 0b0001_0000,
} as const;

/** The stream id reserved for session-level control frames. */
export const SESSION_CONTROL_STREAM_ID = 0;

export interface MuxFrame {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly seq: number;
  readonly qos: QosClassValue;
  readonly chunked: boolean;
  readonly chunkFirst: boolean;
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
  readonly chunkFirst: boolean;
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

/**
 * The manifests each side advertises at session open - the same
 * floor/optional split the local ws OPEN frame carries, with the same
 * semantics:
 *
 * - `rpc` is the RELEASED FLOOR - the frozen method set both sides must
 *   serve. It is the ONLY surface the session-level compatibility check
 *   runs over; a floor mismatch is fatal to the session.
 * - `optionalRpc` holds every non-floor method. It is merged with `rpc` for
 *   version selection, dispatch, and UI capability gating, and is NEVER
 *   compat-checked: a peer missing an optional method degrades (the feature
 *   hides or the call fails typed), it does not kill the session. Without
 *   this split, any version skew between client and host would fatal the
 *   whole remote session - exactly what keeping methods off the floor is
 *   meant to prevent.
 * - `stream` stays a single merged map: stream methods are checked
 *   per-subscription at open (a missing method fails that one stream, not
 *   the session), so a session-level floor for them adds nothing.
 *
 * `optionalRpc` is deliberately REQUIRED, not `.default({})`. Tolerating its
 * absence would only move the failure: a pre-split peer sends its floor and
 * optional methods MERGED in `rpc`, so the floor check would then compare a
 * merged set against a floor set and fatal the session anyway - with a
 * confusing compat error instead of an honest "malformed frame". The mux is
 * unreleased, so no such peer exists; when it ships, a future frame-shape
 * change gets the same treatment this split did - evolve the shape while it
 * is still pre-release, or version the frame. See
 * `remote-session.test.ts` > "RemoteSession openAck without optionalRpc",
 * which pins the rejection.
 */
export interface SessionManifests {
  readonly rpc: ConnectionManifest;
  readonly optionalRpc: ConnectionManifest;
  readonly stream: ConnectionManifest;
}

/** Host ack of `open`: its own split manifests + additive capabilities. */
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
  optionalRpc: connectionManifestSchema,
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
      `mux frame exceeds the ${MAX_MUX_FRAME_PLAINTEXT_BYTES}-byte plaintext cap (${MAX_MUX_FRAME_BYTES}-byte relay cap − ${NOISE_TRANSPORT_OVERHEAD_BYTES}-byte Noise overhead): ${byteLength} bytes`,
    );
    this.name = "MuxFrameSizeError";
  }
}

/**
 * A LOGICAL mux message (the whole encoded body, before/after chunking) over
 * {@link MAX_MUX_MESSAGE_BYTES}. Deterministic per message — routed to
 * per-stream fatal handling, never treated as a droppable transient — on the
 * sender at body encode and on the receiver as a chunk sequence accumulates.
 */
export class MuxMessageSizeError extends Error {
  constructor(byteLength: number) {
    super(
      `mux message exceeds ${MAX_MUX_MESSAGE_BYTES}-byte cap: ${byteLength} bytes`,
    );
    this.name = "MuxMessageSizeError";
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
  if (input.chunkFirst) {
    flags |= MuxFlags.CHUNK_FIRST;
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
  // A view, not a copy: at chunked-transfer scale a copy per frame doubles
  // peak receive memory. The backing buffer is this frame's own decrypt
  // output, never reused, so aliasing is safe and the view holds at most the
  // 15-byte header beyond the payload.
  const binary = hasBinary ? bytes.subarray(jsonEnd) : null;

  return {
    type,
    streamId,
    seq,
    qos: (flags & MuxFlags.BULK) !== 0 ? QosClass.BULK : QosClass.INTERACTIVE,
    chunked: (flags & MuxFlags.CHUNKED) !== 0,
    chunkFirst: (flags & MuxFlags.CHUNK_FIRST) !== 0,
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
  if (byteLength > MAX_MUX_FRAME_PLAINTEXT_BYTES) {
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
