import { describe, it, expect } from "vitest";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseSession,
  CipherState,
  NoiseNonceError,
  NoiseReplayError,
  DEFAULT_REPLAY_WINDOW_SIZE,
} from "../index";
import { decodeUint64BE } from "../bytes";
import type { NoiseHandshakeState } from "../handshake-state";

const enc = new TextEncoder();
const dec = new TextDecoder();
const EMPTY = new Uint8Array(0);

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
  return establishSessionsWithReplayWindow(DEFAULT_REPLAY_WINDOW_SIZE);
}

async function establishSessionsWithReplayWindow(
  replayWindowSize: number,
): Promise<{
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
  return {
    client: NoiseSession.fromHandshake(initiator, replayWindowSize),
    host: NoiseSession.fromHandshake(responder, replayWindowSize),
  };
}

/** Read the 8-byte big-endian counter out of a transport frame header. */
function counterOf(frame: Uint8Array): bigint {
  return decodeUint64BE(frame, 1);
}

function rewindSendCounter(session: NoiseSession, counter: bigint): void {
  Object.defineProperty(session, "sendCounter", {
    value: counter,
    writable: true,
    configurable: true,
  });
}

function sendCipherOf(session: NoiseSession): CipherState {
  const value: unknown = Object.getOwnPropertyDescriptor(
    session,
    "sendCipher",
  )?.value;
  if (value instanceof CipherState) {
    return value;
  }
  throw new Error("NoiseSession sendCipher is not inspectable");
}

/**
 * Regression coverage for T8-F1: a single E2E session multiplexes N mux streams
 * (architecture §3), so `encrypt`/`decrypt` are called concurrently on a shared
 * session. Counter allocation must be atomic and nonces must never be reused.
 */
describe("NoiseSession concurrency safety (T8-F1)", () => {
  it("round-trips transport frames with strictly increasing wire counters", async () => {
    const { client, host } = await establishSessions();
    const frames: Uint8Array[] = [];
    for (const label of ["m0", "m1", "m2", "m3"]) {
      frames.push(await client.encrypt(enc.encode(label), EMPTY));
    }

    expect(frames.map(counterOf)).toEqual([0n, 1n, 2n, 3n]);
    expect(client.currentSendCounter()).toBe(4n);

    const opened: string[] = [];
    for (const frame of frames) {
      opened.push(dec.decode(await host.decrypt(frame, EMPTY)));
    }
    expect(opened).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("uses a real sliding replay window on the transport decrypt path", async () => {
    const { client, host } = await establishSessionsWithReplayWindow(4);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 6; i += 1) {
      frames.push(await client.encrypt(enc.encode(`m${i}`), EMPTY));
    }

    expect(dec.decode(await host.decrypt(frames[5], EMPTY))).toBe("m5");
    expect(dec.decode(await host.decrypt(frames[3], EMPTY))).toBe("m3");
    await expect(host.decrypt(frames[0], EMPTY)).rejects.toBeInstanceOf(
      NoiseReplayError,
    );
    await expect(host.decrypt(frames[3], EMPTY)).rejects.toBeInstanceOf(
      NoiseReplayError,
    );
  });

  it("fails closed if the transport send counter is rewound before encrypt", async () => {
    const { client } = await establishSessions();
    await client.encrypt(enc.encode("first"), EMPTY);
    rewindSendCounter(client, 0n);

    await expect(
      client.encrypt(enc.encode("repeat"), EMPTY),
    ).rejects.toBeInstanceOf(NoiseNonceError);
  });

  it("keeps the no-rewind guard after the send cipher is rekeyed", async () => {
    const { client } = await establishSessions();
    await client.encrypt(enc.encode("first"), EMPTY);
    await sendCipherOf(client).rekey();
    rewindSendCounter(client, 0n);

    await expect(
      client.encrypt(enc.encode("after-rekey"), EMPTY),
    ).rejects.toBeInstanceOf(NoiseNonceError);
  });

  it("assigns distinct counters to concurrent encrypts (no (key,nonce) reuse)", async () => {
    const { client, host } = await establishSessions();

    const [frameA, frameB] = await Promise.all([
      client.encrypt(enc.encode("A"), EMPTY),
      client.encrypt(enc.encode("B"), EMPTY),
    ]);

    const counterA = counterOf(frameA);
    const counterB = counterOf(frameB);
    expect(counterA).not.toBe(counterB);
    expect(new Set([counterA, counterB])).toEqual(new Set([0n, 1n]));
    expect(client.currentSendCounter()).toBe(2n);

    // Both frames must authenticate on the peer — proof the two seals used
    // different (key, nonce) pairs and neither was clobbered.
    const [first, second] =
      counterA < counterB ? [frameA, frameB] : [frameB, frameA];
    const openedFirst = dec.decode(await host.decrypt(first, EMPTY));
    const openedSecond = dec.decode(await host.decrypt(second, EMPTY));
    expect(new Set([openedFirst, openedSecond])).toEqual(new Set(["A", "B"]));
  });

  it("assigns a unique counter to every frame under a large concurrent burst", async () => {
    const { client } = await establishSessions();
    const burst = 64;
    const frames = await Promise.all(
      Array.from({ length: burst }, (_unused, i) =>
        client.encrypt(enc.encode(`m${i}`), EMPTY),
      ),
    );
    const counters = frames.map(counterOf);
    expect(new Set(counters).size).toBe(burst); // all distinct — no reuse
    expect(client.currentSendCounter()).toBe(BigInt(burst));
  });

  it("decrypts concurrently-delivered frames without nonce clobbering", async () => {
    const { client, host } = await establishSessions();
    const messages = ["m0", "m1", "m2", "m3", "m4"];

    // Encrypt sequentially to produce well-ordered frames, then decrypt them
    // all concurrently: the shared receive cipher must not be corrupted.
    const frames: Uint8Array[] = [];
    for (const m of messages) {
      frames.push(await client.encrypt(enc.encode(m), EMPTY));
    }
    const opened = await Promise.all(frames.map((f) => host.decrypt(f, EMPTY)));
    expect(opened.map((o) => dec.decode(o))).toEqual(messages);
  });

  it("still rejects a replay even when delivered concurrently with the original", async () => {
    const { client, host } = await establishSessions();
    const frame = await client.encrypt(enc.encode("dup"), EMPTY);

    const outcomes = await Promise.allSettled([
      host.decrypt(frame, EMPTY),
      host.decrypt(frame, EMPTY),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      NoiseReplayError,
    );
  });
});
