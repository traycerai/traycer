/**
 * What the remote session's mux rides on between its socket and itself.
 *
 * Two implementations, one per way a session reaches its peer:
 *
 *  - {@link NoiseChannel} for a host behind the relay: the relay forwards
 *    bytes it must not read, so every mux frame is sealed end to end, after a
 *    Noise-NK handshake against the host's published static key.
 *  - {@link PLAIN_MUX_CHANNEL} for the server pool, dialed directly over
 *    `wss:`: nothing sits between the client and the peer that TLS does not
 *    already cover, the pool is trusted infrastructure with no static key to
 *    pin, and it would decrypt to plaintext anyway. Mux frames go out as they
 *    are.
 *
 * Everything above this seam (`open` / `openAck`, version negotiation,
 * credits, chunking, compression, the silence probe) is the same code on both,
 * which is what keeps the pool's handshake byte-identical to a host's.
 */
export interface MuxChannel {
  /**
   * The handshake to run once the socket is attached, or `null` when the
   * channel needs none and the session may send its `open` at once.
   */
  readonly handshake: MuxChannelHandshake | null;
  /** Seals one encoded mux frame for the socket. */
  encrypt(muxFrame: Uint8Array): Promise<Uint8Array>;
  /**
   * Opens one inbound socket frame back into an encoded mux frame. Entered
   * synchronously per arrival, and each implementation resumes its callers in
   * call order: the session relies on that to keep chunk sequences contiguous.
   */
  decrypt(transportFrame: Uint8Array): Promise<Uint8Array>;
  /** Releases key material; the channel is unusable afterwards. */
  wipe(): void;
}

/** The initiator half of a two-message handshake carried on the socket. */
export interface MuxChannelHandshake {
  writeInitiatorMessage(): Promise<Uint8Array>;
  readResponderMessage(responderMessage: Uint8Array): Promise<void>;
}

/**
 * The pool's channel: TLS is the boundary, so frames pass through unchanged.
 * Stateless, hence one shared instance; every promise it returns is already
 * settled, so callers resume in the order they called.
 */
export const PLAIN_MUX_CHANNEL: MuxChannel = Object.freeze({
  handshake: null,
  encrypt: (muxFrame: Uint8Array) => Promise.resolve(muxFrame),
  decrypt: (transportFrame: Uint8Array) => Promise.resolve(transportFrame),
  wipe: () => undefined,
});
