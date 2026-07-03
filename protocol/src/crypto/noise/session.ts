import { Mutex } from "async-mutex";
import { concatBytes, decodeUint64BE, encodeUint64BE } from "./bytes";
import {
  DEFAULT_REPLAY_WINDOW_SIZE,
  MAX_NONCE,
  NOISE_SUITE_V1,
  TRANSPORT_HEADER_LEN,
} from "./constants";
import type { CipherState } from "./cipher-state";
import { NoiseDecryptError, NoiseNonceError, NoiseReplayError } from "./errors";
import type { NoiseHandshakeState } from "./handshake-state";
import { ReplayWindow } from "./replay-window";

/**
 * The post-handshake transport. Unlike bare Noise transport (implicit,
 * strictly-sequential nonces that assume in-order reliable delivery), this
 * session carries an **explicit monotonic counter** in each frame and enforces
 * anti-replay with a sliding window — because the relay/mux underneath may
 * reorder, duplicate, or drop frames. That explicit counter is the reviewed
 * transport-path deviation from the "cipher-state counter only" wording: the
 * stateless cipher API still receives a single synchronously reserved counter,
 * and this session guards it so a future rekey/resume/refactor cannot rewind
 * and reuse a (key, nonce) pair.
 *
 * Frame wire format:  `[v:1][counter:8 big-endian][AES-GCM ciphertext‖tag]`
 *  - `v` (envelope suite version) enables suite agility.
 *  - `counter` doubles as the AEAD nonce input; it is authenticated (it is part
 *    of the AEAD associated data), so it cannot be tampered with.
 *
 * **Concurrency invariant (T8-F1).** A single session multiplexes N mux streams
 * (architecture §3), so both directions are exercised concurrently:
 *  - `encrypt` is concurrency-safe: the send counter is reserved *synchronously*
 *    (no await between read and increment) and the seal runs through the
 *    stateless `CipherState.sealWithNonce`, so every concurrent frame gets a
 *    unique nonce and no (key, nonce) pair is ever reused.
 *  - `decrypt` is serialized per session behind a mutex, so the check → open →
 *    commit against the shared replay window is atomic (a concurrent duplicate
 *    cannot slip past the window, and the receive nonce is never clobbered).
 *
 * Forward secrecy is per-session: the NK handshake derives these transport keys
 * from fresh ephemeral X25519 keys (the `ee` DH), so once a session ends and its
 * keys are wiped, later compromise of the host's static key cannot decrypt this
 * session's traffic.
 */
export class NoiseSession {
  private readonly sendCipher: CipherState;
  private readonly receiveCipher: CipherState;
  private readonly replayWindow: ReplayWindow;
  private readonly receiveLock = new Mutex();
  private sendCounter = 0n;
  private lastReservedSendCounter: bigint | null = null;
  readonly handshakeHash: Uint8Array;

  constructor(
    sendCipher: CipherState,
    receiveCipher: CipherState,
    handshakeHash: Uint8Array,
    replayWindowSize: number,
  ) {
    this.sendCipher = sendCipher;
    this.receiveCipher = receiveCipher;
    this.handshakeHash = handshakeHash;
    this.replayWindow = new ReplayWindow(replayWindowSize);
  }

  /** Build a session from a completed handshake, mapping send/receive by role. */
  static fromHandshake(
    handshake: NoiseHandshakeState,
    replayWindowSize: number,
  ): NoiseSession {
    const { send, receive } = handshake.getTransportCiphers();
    return new NoiseSession(
      send,
      receive,
      handshake.getHandshakeHash(),
      replayWindowSize,
    );
  }

  /** The next counter this session will emit (for assertions/tests). */
  currentSendCounter(): bigint {
    return this.sendCounter;
  }

  /**
   * Seal `plaintext` into a transport frame. Safe to call concurrently: the
   * counter is reserved synchronously before any await. `associatedData` lets a
   * caller (e.g. the mux above) bind outer routing metadata to the frame; it is
   * authenticated but not encrypted. Pass an empty array when there is none.
   */
  async encrypt(
    plaintext: Uint8Array,
    associatedData: Uint8Array,
  ): Promise<Uint8Array> {
    const counter = this.reserveSendCounter();
    const header = buildHeader(counter);
    const ciphertext = await this.sendCipher.sealWithNonce(
      counter,
      concatBytes([header, associatedData]),
      plaintext,
    );
    return concatBytes([header, ciphertext]);
  }

  /**
   * Open a transport frame. Serialized per session so the counter is checked
   * against the replay window, the frame is opened, and the window is advanced
   * as one atomic step. The window advances *only after* the AEAD tag verifies,
   * so a forged frame can neither be accepted nor poison the window.
   */
  async decrypt(
    frame: Uint8Array,
    associatedData: Uint8Array,
  ): Promise<Uint8Array> {
    if (frame.length < TRANSPORT_HEADER_LEN) {
      throw new NoiseDecryptError("transport frame is too short");
    }
    const version = frame[0];
    if (version !== NOISE_SUITE_V1) {
      throw new NoiseDecryptError(`unsupported suite version: ${version}`);
    }
    const counter = decodeUint64BE(frame, 1);
    const header = frame.slice(0, TRANSPORT_HEADER_LEN);
    const ciphertext = frame.slice(TRANSPORT_HEADER_LEN);

    return this.receiveLock.runExclusive(async () => {
      if (!this.replayWindow.check(counter)) {
        throw new NoiseReplayError(
          `replayed or stale frame counter: ${counter}`,
        );
      }
      const plaintext = await this.receiveCipher.openWithNonce(
        counter,
        concatBytes([header, associatedData]),
        ciphertext,
      );
      this.replayWindow.commit(counter);
      return plaintext;
    });
  }

  /** Reserve and advance the send counter synchronously (no await inside). */
  private reserveSendCounter(): bigint {
    if (this.sendCounter >= MAX_NONCE) {
      throw new NoiseNonceError(
        "send counter exhausted; a new session is required",
      );
    }
    const counter = this.sendCounter;
    if (
      this.lastReservedSendCounter !== null &&
      counter <= this.lastReservedSendCounter
    ) {
      throw new NoiseNonceError(
        "send counter would repeat or rewind; a new session is required",
      );
    }
    this.sendCounter = counter + 1n;
    this.lastReservedSendCounter = counter;
    return counter;
  }

  /** Zero both transport keys. The session is unusable afterwards. */
  wipe(): void {
    this.sendCipher.wipe();
    this.receiveCipher.wipe();
  }
}

/** Serialize the `[v:1][counter:8]` frame header. */
function buildHeader(counter: bigint): Uint8Array {
  const header = new Uint8Array(TRANSPORT_HEADER_LEN);
  header[0] = NOISE_SUITE_V1;
  header.set(encodeUint64BE(counter), 1);
  return header;
}

export { DEFAULT_REPLAY_WINDOW_SIZE };
