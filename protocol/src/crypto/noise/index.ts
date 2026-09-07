/**
 * Noise_NK_25519_AESGCM_SHA256 - the shared end-to-end crypto primitive for the remote-host transport.
 * Handshake shape (NK): the responder's static X25519 key authenticates the host; the initiator is anonymous at the Noise layer and authenticates in-channel later with a bearer (that bearer step lives above this module).
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
export { generateKeyPair, publicKeyFromPrivate } from "./primitives";
export { bytesToHex, hexToBytes } from "./bytes";

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
