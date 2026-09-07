/** Which end of the Noise handshake a party is playing. */
export type NoiseRole = "initiator" | "responder";

/** An X25519 key pair. */
export interface NoiseKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}
