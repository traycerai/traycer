import {
  createInitiatorHandshake,
  NoiseSession,
  DEFAULT_REPLAY_WINDOW_SIZE,
  KEY_LEN,
  type NoiseHandshakeState,
} from "@traycer/protocol/crypto/noise";
import { NOISE_PROLOGUE } from "@traycer/protocol/host-transport/mux";

/**
 * The client's end-to-end Noise-NK channel (T8 crypto; Architecture §4). A fresh
 * channel is built per session — including per full-attach resume — so each
 * session has its own forward-secret transport keys derived from fresh
 * ephemerals (a later host-static-key compromise cannot decrypt past sessions).
 *
 * The crypto state machine itself lives in `@traycer/protocol/crypto/noise`; this
 * class is only the client-side wiring: run the NK initiator handshake, then
 * seal/open mux frames over the resulting `NoiseSession`.
 *
 * NK handshake (2 messages): initiator → `msg0 (e, es)`, responder → `msg1 (e,
 * ee)`. The initiator is anonymous at the Noise layer; identity is proven later
 * in-channel via the mux `open{bearer}` frame (R4-A2). Associated data is empty
 * on the client leg — the relay owns/stamps `sid`, so there is no outer routing
 * metadata for the client to bind (the monotonic counter + replay window already
 * defeat replay). Pinned by
 * `@traycer/protocol/host-transport/__tests__/associated-data-invariant.test.ts`
 * — a future mux field externalized outside the ciphertext must be bound via
 * AD there, not left unbound like `sid`.
 */

const EMPTY_ASSOCIATED_DATA = new Uint8Array(0);

export class NoiseChannel {
  private readonly handshake: NoiseHandshakeState;
  private session: NoiseSession | null = null;

  private constructor(handshake: NoiseHandshakeState) {
    this.handshake = handshake;
  }

  /** Begins an NK handshake against the host's registry-published static key. */
  static async begin(hostStaticPublicKey: Uint8Array): Promise<NoiseChannel> {
    const handshake = await createInitiatorHandshake(
      hostStaticPublicKey,
      NOISE_PROLOGUE,
    );
    return new NoiseChannel(handshake);
  }

  /** Produces the initiator's `msg0` to forward to the host through the relay. */
  writeInitiatorMessage(): Promise<Uint8Array> {
    return this.handshake.writeMessage(EMPTY_ASSOCIATED_DATA);
  }

  /** Consumes the responder's `msg1`, completing the handshake + deriving keys. */
  async readResponderMessage(msg1: Uint8Array): Promise<void> {
    await this.handshake.readMessage(msg1);
    this.session = NoiseSession.fromHandshake(
      this.handshake,
      DEFAULT_REPLAY_WINDOW_SIZE,
    );
  }

  /** True once the transport session keys are established. */
  isEstablished(): boolean {
    return this.session !== null;
  }

  /** Seals a mux frame into a Noise transport frame for the relay to forward. */
  async encrypt(muxFrame: Uint8Array): Promise<Uint8Array> {
    const session = this.requireSession();
    return session.encrypt(muxFrame, EMPTY_ASSOCIATED_DATA);
  }

  /** Opens an inbound Noise transport frame back into a mux frame. */
  async decrypt(transportFrame: Uint8Array): Promise<Uint8Array> {
    const session = this.requireSession();
    return session.decrypt(transportFrame, EMPTY_ASSOCIATED_DATA);
  }

  /** Zeroes the transport keys; the channel is unusable afterwards. */
  wipe(): void {
    if (this.session !== null) {
      this.session.wipe();
      this.session = null;
    }
  }

  private requireSession(): NoiseSession {
    if (this.session === null) {
      throw new NoiseChannelNotReadyError(
        "Noise transport used before the handshake completed",
      );
    }
    return this.session;
  }
}

export class NoiseChannelNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseChannelNotReadyError";
  }
}

/** Thrown when a registry-published host public key is not a valid X25519 key. */
export class InvalidHostPublicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHostPublicKeyError";
  }
}

/**
 * Decodes the host's static public key from its `GET /hosts` DTO string form
 * (Architecture §5). The encoding authn-v3 publishes is not pinned in the
 * client contract, so this accepts hex (64 chars) or base64/base64url and
 * validates the decoded length is a 32-byte X25519 key — a wrong encoding is a
 * hard, surfaced failure (never a silent MITM-shaped mismatch).
 *
 * ⚠️ Reconcile the exact publish encoding with T3/T5 (authn-v3 registry).
 */
export function decodeHostPublicKey(published: string): Uint8Array {
  const bytes = /^[0-9a-fA-F]+$/.test(published)
    ? hexToBytesStrict(published)
    : base64ToBytes(published);
  if (bytes.length !== KEY_LEN) {
    throw new InvalidHostPublicKeyError(
      `host public key must be ${KEY_LEN} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new InvalidHostPublicKeyError("host public key hex has odd length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new InvalidHostPublicKeyError("host public key hex is malformed");
    }
    out[i] = byte;
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new InvalidHostPublicKeyError("host public key is not valid base64");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
