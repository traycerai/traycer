import { concatBytes } from "./bytes";
import { DH_LEN } from "./constants";
import { CipherState } from "./cipher-state";
import { NoiseHandshakeError, NoiseStateError } from "./errors";
import { dh } from "./primitives";
import { SymmetricState } from "./symmetric-state";
import type { NoiseKeyPair, NoiseRole } from "./types";

/**
 * The NK message pattern (Noise spec §7.5):
 *
 *   NK:
 *     <- s          (pre-message: initiator already holds the responder static)
 *     ...
 *     -> e, es      (message 0, written by the initiator)
 *     <- e, ee      (message 1, written by the responder)
 *
 * The responder's static key authenticates the host; the initiator is anonymous
 * at the Noise layer (it carries no static key) and authenticates in-channel
 * later with a bearer — that in-channel step is out of scope here.
 */
const NK_MESSAGE_PATTERNS: readonly (readonly string[])[] = [
  ["e", "es"],
  ["e", "ee"],
];

/**
 * Fully-explicit handshake configuration. Nothing is optional or defaulted: the
 * factory helpers in `index.ts` fill the production values (random ephemeral),
 * and tests pass fixed ephemerals to reproduce official vectors.
 */
export interface NoiseHandshakeConfig {
  readonly role: NoiseRole;
  /** Noise prologue mixed into `h` before the first message (may be empty). */
  readonly prologue: Uint8Array;
  /** Responder's static key pair; `null` for the initiator (anonymous in NK). */
  readonly localStaticKeyPair: NoiseKeyPair | null;
  /** Responder static public key known to the initiator; `null` for responder. */
  readonly remoteStaticPublicKey: Uint8Array | null;
  /** This party's ephemeral key pair (generated fresh per session). */
  readonly localEphemeralKeyPair: NoiseKeyPair;
}

/** Send/receive transport ciphers produced when the handshake completes. */
export interface NoiseTransportCiphers {
  readonly send: CipherState;
  readonly receive: CipherState;
}

export class NoiseHandshakeState {
  private readonly symmetric: SymmetricState;
  private readonly role: NoiseRole;
  private readonly s: NoiseKeyPair | null;
  private readonly e: NoiseKeyPair;
  private readonly rs: Uint8Array | null;
  private re: Uint8Array | null = null;
  private messageIndex = 0;
  private transport: NoiseTransportCiphers | null = null;

  private constructor(config: NoiseHandshakeConfig, symmetric: SymmetricState) {
    this.role = config.role;
    this.s = config.localStaticKeyPair;
    this.e = config.localEphemeralKeyPair;
    this.rs = config.remoteStaticPublicKey;
    this.symmetric = symmetric;
  }

  /**
   * Initialize an NK handshake: hash the prologue, then apply the `<- s`
   * pre-message by mixing the responder's static public key into the transcript
   * (both parties know it — the responder from its own key pair, the initiator
   * from the registry).
   */
  static async create(
    config: NoiseHandshakeConfig,
  ): Promise<NoiseHandshakeState> {
    const responderStatic =
      config.role === "responder"
        ? (config.localStaticKeyPair?.publicKey ?? null)
        : config.remoteStaticPublicKey;
    if (responderStatic === null) {
      throw new NoiseHandshakeError(
        "NK requires the responder static public key",
      );
    }
    if (responderStatic.length !== DH_LEN) {
      throw new NoiseHandshakeError("responder static public key must be 32 bytes");
    }

    const symmetric = SymmetricState.initialize();
    const handshake = new NoiseHandshakeState(config, symmetric);
    await symmetric.mixHash(config.prologue);
    await symmetric.mixHash(responderStatic);
    return handshake;
  }

  isHandshakeComplete(): boolean {
    return this.transport !== null;
  }

  getHandshakeHash(): Uint8Array {
    return this.symmetric.getHandshakeHash();
  }

  /** The transport ciphers, valid only after the handshake completes. */
  getTransportCiphers(): NoiseTransportCiphers {
    if (this.transport === null) {
      throw new NoiseStateError("handshake is not complete");
    }
    return this.transport;
  }

  /**
   * Write the next handshake message: process each pattern token, then append
   * the (possibly-encrypted) payload. Returns the bytes to send.
   */
  async writeMessage(payload: Uint8Array): Promise<Uint8Array> {
    const tokens = this.tokensForTurn("write");
    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      if (token === "e") {
        await this.symmetric.mixHash(this.e.publicKey);
        parts.push(this.e.publicKey);
      } else {
        await this.symmetric.mixKey(this.computeDh(token));
      }
    }
    parts.push(await this.symmetric.encryptAndHash(payload));
    await this.finishMessage();
    return concatBytes(parts);
  }

  /**
   * Read the next handshake message: consume each pattern token from the wire
   * bytes, then decrypt the trailing payload. Returns the decrypted payload.
   */
  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = this.tokensForTurn("read");
    let offset = 0;
    for (const token of tokens) {
      if (token === "e") {
        if (message.length - offset < DH_LEN) {
          throw new NoiseHandshakeError("handshake message truncated at ephemeral");
        }
        this.re = message.slice(offset, offset + DH_LEN);
        offset += DH_LEN;
        await this.symmetric.mixHash(this.re);
      } else {
        await this.symmetric.mixKey(this.computeDh(token));
      }
    }
    const payload = await this.symmetric.decryptAndHash(message.slice(offset));
    await this.finishMessage();
    return payload;
  }

  private tokensForTurn(operation: "read" | "write"): readonly string[] {
    if (this.transport !== null) {
      throw new NoiseStateError("handshake already complete");
    }
    if (this.messageIndex >= NK_MESSAGE_PATTERNS.length) {
      throw new NoiseStateError("no further handshake messages");
    }
    const writerIsInitiator = this.messageIndex % 2 === 0;
    const iAmWriter = (this.role === "initiator") === writerIsInitiator;
    if (operation === "write" && !iAmWriter) {
      throw new NoiseStateError("it is not this party's turn to write");
    }
    if (operation === "read" && iAmWriter) {
      throw new NoiseStateError("it is not this party's turn to read");
    }
    return NK_MESSAGE_PATTERNS[this.messageIndex];
  }

  private async finishMessage(): Promise<void> {
    this.messageIndex += 1;
    if (this.messageIndex < NK_MESSAGE_PATTERNS.length) {
      return;
    }
    const [c1, c2] = await this.symmetric.split();
    // c1 carries initiator->responder traffic, c2 the reverse (spec §5.3).
    this.transport =
      this.role === "initiator"
        ? { send: c1, receive: c2 }
        : { send: c2, receive: c1 };
    // Forward secrecy: the ephemeral private is no longer needed once the
    // transport keys are derived, so zero it (transport keys are wiped via
    // NoiseSession.wipe). The long-lived static key is deliberately left intact.
    this.e.privateKey.fill(0);
  }

  /** Resolve the DH for a token given this party's role (NK uses only es, ee). */
  private computeDh(token: string): Uint8Array {
    switch (token) {
      case "ee":
        return dh(this.e, this.requireRemoteEphemeral());
      case "es":
        return this.role === "initiator"
          ? dh(this.e, this.requireRemoteStatic())
          : dh(this.requireLocalStatic(), this.requireRemoteEphemeral());
      default:
        throw new NoiseHandshakeError(`unexpected handshake token: ${token}`);
    }
  }

  private requireLocalStatic(): NoiseKeyPair {
    if (this.s === null) {
      throw new NoiseHandshakeError("local static key pair is required");
    }
    return this.s;
  }

  private requireRemoteStatic(): Uint8Array {
    if (this.rs === null) {
      throw new NoiseHandshakeError("remote static public key is required");
    }
    return this.rs;
  }

  private requireRemoteEphemeral(): Uint8Array {
    if (this.re === null) {
      throw new NoiseHandshakeError("remote ephemeral public key is required");
    }
    return this.re;
  }
}
