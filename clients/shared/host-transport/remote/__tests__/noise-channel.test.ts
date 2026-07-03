import { describe, expect, it } from "vitest";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseSession,
  DEFAULT_REPLAY_WINDOW_SIZE,
  bytesToHex,
} from "@traycer/protocol/crypto/noise";
import {
  decodeHostPublicKey,
  InvalidHostPublicKeyError,
  NoiseChannel,
  NoiseChannelNotReadyError,
} from "../noise-channel";
import { NOISE_PROLOGUE } from "@traycer/protocol/host-transport/mux";

const EMPTY = new Uint8Array(0);

describe("NoiseChannel (client initiator) interop with the protocol responder", () => {
  it("completes the NK handshake and encrypts/decrypts both directions", async () => {
    const hostStatic = generateStaticKeyPair();
    const client = await NoiseChannel.begin(hostStatic.publicKey);
    const responder = await createResponderHandshake(
      hostStatic,
      NOISE_PROLOGUE,
    );

    const msg0 = await client.writeInitiatorMessage();
    await responder.readMessage(msg0);
    const msg1 = await responder.writeMessage(EMPTY);
    await client.readResponderMessage(msg1);
    const responderSession = NoiseSession.fromHandshake(
      responder,
      DEFAULT_REPLAY_WINDOW_SIZE,
    );

    expect(client.isEstablished()).toBe(true);

    const outbound = new TextEncoder().encode("client→host mux frame");
    const sealed = await client.encrypt(outbound);
    expect(await responderSession.decrypt(sealed, EMPTY)).toEqual(outbound);

    const inbound = new TextEncoder().encode("host→client mux frame");
    const sealedInbound = await responderSession.encrypt(inbound, EMPTY);
    expect(await client.decrypt(sealedInbound)).toEqual(inbound);
  });

  it("rejects transport use before the handshake completes", async () => {
    const hostStatic = generateStaticKeyPair();
    const client = await NoiseChannel.begin(hostStatic.publicKey);
    await expect(client.encrypt(EMPTY)).rejects.toBeInstanceOf(
      NoiseChannelNotReadyError,
    );
  });
});

describe("decodeHostPublicKey", () => {
  it("decodes hex and base64 forms to the same 32-byte key", () => {
    const kp = generateStaticKeyPair();
    const hex = bytesToHex(kp.publicKey);
    const base64 = btoa(String.fromCharCode(...kp.publicKey));
    expect(decodeHostPublicKey(hex)).toEqual(kp.publicKey);
    expect(decodeHostPublicKey(base64)).toEqual(kp.publicKey);
  });

  it("rejects a wrong-length key fail-closed", () => {
    expect(() => decodeHostPublicKey("abcd")).toThrow(
      InvalidHostPublicKeyError,
    );
  });
});
