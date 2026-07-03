/** Which end of the Noise handshake a party is playing. */
export type NoiseRole = "initiator" | "responder";

/**
 * An X25519 key pair. `privateKey` is a 32-byte scalar; `publicKey` is the
 * 32-byte Montgomery-u coordinate. For NK the responder (host) owns a static
 * key pair whose public half the registry publishes; both parties generate a
 * fresh ephemeral key pair per session.
 */
export interface NoiseKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}
