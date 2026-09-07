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

/** The post-handshake transport. */
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

  /** Seal `plaintext` into a transport frame. */
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

  /** Open a transport frame. */
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
