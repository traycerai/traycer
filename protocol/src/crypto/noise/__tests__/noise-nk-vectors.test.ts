import { describe, it, expect } from "vitest";
import { NoiseHandshakeState } from "../handshake-state";
import { bytesToHex, hexToBytes } from "../bytes";
import { publicKeyFromPrivate } from "../primitives";
import type { NoiseKeyPair } from "../types";

/**
 * Security-gate bar #1: official Noise `NK` test vectors pass.
 *
 * Source: the canonical Cacophony test-vector corpus, as published in the
 * `snow` reference implementation:
 *   https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/cacophony.txt
 * (Cacophony is the Haskell Noise implementation whose vectors the Noise
 * community treats as authoritative; noise-c ships the same corpus.)
 *
 * The single object below is the verbatim `Noise_NK_25519_AESGCM_SHA256` entry
 * from that file. `messages[0..1]` are the two NK handshake messages; the
 * remaining entries are post-handshake transport messages alternating
 * initiator->responder / responder->initiator.
 */
const NK_VECTOR = {
  protocol_name: "Noise_NK_25519_AESGCM_SHA256",
  init_prologue: "4a6f686e2047616c74",
  init_ephemeral:
    "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  init_remote_static:
    "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
  resp_static:
    "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  resp_ephemeral:
    "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshake_hash:
    "f8a87aa8add4fea6e33365b89637486c2f6564546ce29d1df9ce9abf78c507d7",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794475ab4d66d222457dd414bc5f296bc7b4078cc7d72af5192628b68bca7d28844b",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext:
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884303c7d89310502baa8299520ba451624c3c0492e2698f8d457c32400b91fd8a",
    },
    {
      payload: "462e20412e20486179656b",
      ciphertext: "304f70c37c93573099228016d54cb15213af94eb598d1b17df1153",
    },
    {
      payload: "4361726c204d656e676572",
      ciphertext: "a1bf6c954529f29b31d8ae9f67d2c18dbd332aa1a0918690c6d80b",
    },
    {
      payload: "4a65616e2d426170746973746520536179",
      ciphertext:
        "2e8f3e51888360b2b2d83a64dde9943c7dd3c5e84ac7c4b4e2d5cfc025b6c854d3",
    },
    {
      payload: "457567656e2042f6686d20766f6e2042617765726b",
      ciphertext:
        "8498bf41212a8b87c9eeb408274c75b3558fd0530865b5a7932d4b3af812d85b3df27e6f33",
    },
  ],
} as const;

function keyPairFromPrivate(privateHex: string): NoiseKeyPair {
  const privateKey = hexToBytes(privateHex);
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

async function makeHandshakes(): Promise<{
  initiator: NoiseHandshakeState;
  responder: NoiseHandshakeState;
}> {
  const prologue = hexToBytes(NK_VECTOR.init_prologue);
  const initiator = await NoiseHandshakeState.create({
    role: "initiator",
    prologue,
    localStaticKeyPair: null,
    remoteStaticPublicKey: hexToBytes(NK_VECTOR.init_remote_static),
    localEphemeralKeyPair: keyPairFromPrivate(NK_VECTOR.init_ephemeral),
  });
  const responder = await NoiseHandshakeState.create({
    role: "responder",
    prologue,
    localStaticKeyPair: keyPairFromPrivate(NK_VECTOR.resp_static),
    remoteStaticPublicKey: null,
    localEphemeralKeyPair: keyPairFromPrivate(NK_VECTOR.resp_ephemeral),
  });
  return { initiator, responder };
}

describe("Noise_NK_25519_AESGCM_SHA256 official vector", () => {
  it("derives the responder public static from the private static", () => {
    // The vector's init_remote_static (what the initiator is given) must equal
    // the X25519 public key of the responder's private static.
    const derived = publicKeyFromPrivate(hexToBytes(NK_VECTOR.resp_static));
    expect(bytesToHex(derived)).toBe(NK_VECTOR.init_remote_static);
  });

  it("reproduces both handshake message ciphertexts exactly", async () => {
    const { initiator, responder } = await makeHandshakes();

    const msg0 = await initiator.writeMessage(
      hexToBytes(NK_VECTOR.messages[0].payload),
    );
    expect(bytesToHex(msg0)).toBe(NK_VECTOR.messages[0].ciphertext);

    const payload0 = await responder.readMessage(msg0);
    expect(bytesToHex(payload0)).toBe(NK_VECTOR.messages[0].payload);

    const msg1 = await responder.writeMessage(
      hexToBytes(NK_VECTOR.messages[1].payload),
    );
    expect(bytesToHex(msg1)).toBe(NK_VECTOR.messages[1].ciphertext);

    const payload1 = await initiator.readMessage(msg1);
    expect(bytesToHex(payload1)).toBe(NK_VECTOR.messages[1].payload);
  });

  it("agrees on the handshake hash on both ends", async () => {
    const { initiator, responder } = await makeHandshakes();
    const msg0 = await initiator.writeMessage(
      hexToBytes(NK_VECTOR.messages[0].payload),
    );
    await responder.readMessage(msg0);
    const msg1 = await responder.writeMessage(
      hexToBytes(NK_VECTOR.messages[1].payload),
    );
    await initiator.readMessage(msg1);

    expect(bytesToHex(initiator.getHandshakeHash())).toBe(
      NK_VECTOR.handshake_hash,
    );
    expect(bytesToHex(responder.getHandshakeHash())).toBe(
      NK_VECTOR.handshake_hash,
    );
  });

  it("reproduces the transport-message ciphertexts (implicit nonce increments)", async () => {
    const { initiator, responder } = await makeHandshakes();
    const msg0 = await initiator.writeMessage(
      hexToBytes(NK_VECTOR.messages[0].payload),
    );
    await responder.readMessage(msg0);
    const msg1 = await responder.writeMessage(
      hexToBytes(NK_VECTOR.messages[1].payload),
    );
    await initiator.readMessage(msg1);

    const initiatorCiphers = initiator.getTransportCiphers();
    const responderCiphers = responder.getTransportCiphers();
    const emptyAd = new Uint8Array(0);

    // Transport messages alternate direction; each direction's nonce increments
    // independently (msg 2/4 share the initiator->responder cipher, msg 3/5 the
    // responder->initiator cipher).
    const transport = NK_VECTOR.messages.slice(2);
    const senders = [
      initiatorCiphers.send,
      responderCiphers.send,
      initiatorCiphers.send,
      responderCiphers.send,
    ];
    const receivers = [
      responderCiphers.receive,
      initiatorCiphers.receive,
      responderCiphers.receive,
      initiatorCiphers.receive,
    ];

    for (let i = 0; i < transport.length; i++) {
      const sealed = await senders[i].encryptWithAd(
        emptyAd,
        hexToBytes(transport[i].payload),
      );
      expect(bytesToHex(sealed)).toBe(transport[i].ciphertext);
      const opened = await receivers[i].decryptWithAd(
        emptyAd,
        hexToBytes(transport[i].ciphertext),
      );
      expect(bytesToHex(opened)).toBe(transport[i].payload);
    }
  });
});
