/**
 * Noise_NK_25519_AESGCM_SHA256 — the shared end-to-end crypto primitive for the
 * remote-host transport. The client (initiator) and host (responder) both
 * consume this module via the deep subpath `@traycer/protocol/crypto/noise`.
 *
 * Handshake shape (NK): the responder's static X25519 key authenticates the
 * host; the initiator is anonymous at the Noise layer and authenticates
 * in-channel later with a bearer (that bearer step lives above this module).
 *
 * Suite choices, spelled out for review:
 *  - DH: X25519 via @noble/curves (the ONLY @noble usage; WebCrypto lacks a
 *    portable X25519 across all target surfaces).
 *  - Cipher: AES-256-GCM via native WebCrypto (no pure-JS AES — it is
 *    timing-unsafe).
 *  - Hash: SHA-256 via native WebCrypto; HKDF is the Noise HMAC construction
 *    built on native HMAC-SHA256.
 *
 * Typical use:
 *   // host static key (persisted; public half published in the registry)
 *   const hostStatic = generateStaticKeyPair();
 *
 *   // initiator (client)
 *   const init = await createInitiatorHandshake(hostStatic.publicKey, prologue);
 *   const msg0 = await init.writeMessage(new Uint8Array(0));   // -> relay -> host
 *   // ...receive msg1...
 *   await init.readMessage(msg1);
 *   const clientSession = NoiseSession.fromHandshake(init, DEFAULT_REPLAY_WINDOW_SIZE);
 *
 *   // responder (host)
 *   const resp = await createResponderHandshake(hostStatic, prologue);
 *   await resp.readMessage(msg0);
 *   const msg1 = await resp.writeMessage(new Uint8Array(0));   // -> relay -> client
 *   const hostSession = NoiseSession.fromHandshake(resp, DEFAULT_REPLAY_WINDOW_SIZE);
 */

import {
  NoiseHandshakeState,
  type NoiseHandshakeConfig,
} from "./handshake-state";
import { generateKeyPair } from "./primitives";
import type { NoiseKeyPair } from "./types";

export {
  NOISE_PROTOCOL_NAME,
  NOISE_SUITE_V1,
  DEFAULT_REPLAY_WINDOW_SIZE,
  DH_LEN,
  KEY_LEN,
  MAX_NONCE,
} from "./constants";
export {
  NoiseError,
  NoiseHandshakeError,
  NoiseDecryptError,
  NoiseNonceError,
  NoiseReplayError,
  NoiseStateError,
} from "./errors";
export { CipherState } from "./cipher-state";
export { ReplayWindow } from "./replay-window";
export { NoiseSession } from "./session";
export {
  NoiseHandshakeState,
  type NoiseHandshakeConfig,
  type NoiseTransportCiphers,
} from "./handshake-state";
export type { NoiseKeyPair, NoiseRole } from "./types";
export {
  generateKeyPair,
  publicKeyFromPrivate,
} from "./primitives";
export { bytesToHex, hexToBytes } from "./bytes";

/**
 * Generate a fresh static X25519 key pair for a host. The public half is
 * published in the registry; the private half is custodied on the box (0600 /
 * OS keystore — that custody is the host daemon's responsibility, not this
 * module's).
 */
export function generateStaticKeyPair(): NoiseKeyPair {
  return generateKeyPair();
}

/**
 * Start an NK handshake as the initiator (client). The initiator is anonymous:
 * it holds no static key, only the responder's published static public key.
 */
export function createInitiatorHandshake(
  remoteStaticPublicKey: Uint8Array,
  prologue: Uint8Array,
): Promise<NoiseHandshakeState> {
  const config: NoiseHandshakeConfig = {
    role: "initiator",
    prologue,
    localStaticKeyPair: null,
    remoteStaticPublicKey,
    localEphemeralKeyPair: generateKeyPair(),
  };
  return NoiseHandshakeState.create(config);
}

/**
 * Start an NK handshake as the responder (host), authenticating with the host's
 * static key pair.
 */
export function createResponderHandshake(
  staticKeyPair: NoiseKeyPair,
  prologue: Uint8Array,
): Promise<NoiseHandshakeState> {
  const config: NoiseHandshakeConfig = {
    role: "responder",
    prologue,
    localStaticKeyPair: staticKeyPair,
    remoteStaticPublicKey: null,
    localEphemeralKeyPair: generateKeyPair(),
  };
  return NoiseHandshakeState.create(config);
}
