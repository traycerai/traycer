import { describe, it, expect } from "vitest";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseSession,
  NoiseDecryptError,
  NoiseReplayError,
  DEFAULT_REPLAY_WINDOW_SIZE,
} from "../index";
import { bytesToHex } from "../bytes";
import type { NoiseHandshakeState } from "../handshake-state";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Drive an NK handshake to completion between two live parties. */
async function completeHandshake(
  initiator: NoiseHandshakeState,
  responder: NoiseHandshakeState,
): Promise<void> {
  const msg0 = await initiator.writeMessage(new Uint8Array(0));
  await responder.readMessage(msg0);
  const msg1 = await responder.writeMessage(new Uint8Array(0));
  await initiator.readMessage(msg1);
}

async function establishSessions(): Promise<{
  client: NoiseSession;
  host: NoiseSession;
}> {
  const hostStatic = generateStaticKeyPair();
  const prologue = enc.encode("remote-host/v1");
  const initiator = await createInitiatorHandshake(
    hostStatic.publicKey,
    prologue,
  );
  const responder = await createResponderHandshake(hostStatic, prologue);
  await completeHandshake(initiator, responder);

  expect(bytesToHex(initiator.getHandshakeHash())).toBe(
    bytesToHex(responder.getHandshakeHash()),
  );

  return {
    client: NoiseSession.fromHandshake(initiator, DEFAULT_REPLAY_WINDOW_SIZE),
    host: NoiseSession.fromHandshake(responder, DEFAULT_REPLAY_WINDOW_SIZE),
  };
}

describe("Noise NK in-process interop", () => {
  it("completes the handshake and exchanges frames in both directions", async () => {
    const { client, host } = await establishSessions();
    const emptyAd = new Uint8Array(0);

    const toHost = await client.encrypt(enc.encode("ping"), emptyAd);
    expect(dec.decode(await host.decrypt(toHost, emptyAd))).toBe("ping");

    const toClient = await host.encrypt(enc.encode("pong"), emptyAd);
    expect(dec.decode(await client.decrypt(toClient, emptyAd))).toBe("pong");
  });

  it("rejects a replayed frame", async () => {
    const { client, host } = await establishSessions();
    const emptyAd = new Uint8Array(0);
    const frame = await client.encrypt(enc.encode("once"), emptyAd);

    expect(dec.decode(await host.decrypt(frame, emptyAd))).toBe("once");
    await expect(host.decrypt(frame, emptyAd)).rejects.toBeInstanceOf(
      NoiseReplayError,
    );
  });

  it("rejects a tampered frame without advancing anti-replay state", async () => {
    const { client, host } = await establishSessions();
    const emptyAd = new Uint8Array(0);
    const good = await client.encrypt(enc.encode("intact"), emptyAd);

    const tampered = good.slice();
    tampered[tampered.length - 1] ^= 0x80;
    await expect(host.decrypt(tampered, emptyAd)).rejects.toBeInstanceOf(
      NoiseDecryptError,
    );

    // the genuine frame at that counter still opens (window was not poisoned).
    expect(dec.decode(await host.decrypt(good, emptyAd))).toBe("intact");
  });

  it("accepts reordered frames and still rejects replays among them", async () => {
    const { client, host } = await establishSessions();
    const emptyAd = new Uint8Array(0);
    const f0 = await client.encrypt(enc.encode("m0"), emptyAd);
    const f1 = await client.encrypt(enc.encode("m1"), emptyAd);
    const f2 = await client.encrypt(enc.encode("m2"), emptyAd);

    // deliver out of order: 2, 0, 1
    expect(dec.decode(await host.decrypt(f2, emptyAd))).toBe("m2");
    expect(dec.decode(await host.decrypt(f0, emptyAd))).toBe("m0");
    expect(dec.decode(await host.decrypt(f1, emptyAd))).toBe("m1");

    // any of them replayed is now rejected.
    await expect(host.decrypt(f0, emptyAd)).rejects.toBeInstanceOf(
      NoiseReplayError,
    );
  });

  it("binds associated data: a frame decrypted under different AD fails", async () => {
    const { client, host } = await establishSessions();
    const frame = await client.encrypt(enc.encode("bound"), enc.encode("ad-A"));
    await expect(host.decrypt(frame, enc.encode("ad-B"))).rejects.toBeInstanceOf(
      NoiseDecryptError,
    );
  });

  it("fails the handshake when the initiator has the wrong host static key", async () => {
    const hostStatic = generateStaticKeyPair();
    const wrongStatic = generateStaticKeyPair();
    const prologue = new Uint8Array(0);

    const initiator = await createInitiatorHandshake(
      wrongStatic.publicKey, // client believes a different host static
      prologue,
    );
    const responder = await createResponderHandshake(hostStatic, prologue);

    const msg0 = await initiator.writeMessage(new Uint8Array(0));
    // the responder's `es` DH differs from the initiator's, so the payload tag
    // fails to authenticate -> a MITM with a swapped key cannot complete NK.
    await expect(responder.readMessage(msg0)).rejects.toThrow();
  });

  it("uses fresh ephemerals per session (per-session forward secrecy)", async () => {
    const a = await establishSessions();
    const b = await establishSessions();
    // Distinct sessions derive distinct transcripts/keys from fresh ephemerals.
    expect(bytesToHex(a.client.handshakeHash)).not.toBe(
      bytesToHex(b.client.handshakeHash),
    );
  });
});
