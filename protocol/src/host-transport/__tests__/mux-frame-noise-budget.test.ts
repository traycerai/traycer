import { describe, expect, it } from "vitest";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseSession,
  DEFAULT_REPLAY_WINDOW_SIZE,
} from "@traycer/protocol/crypto/noise";
import {
  assertMuxFrameFits,
  encodeMuxFrame,
  encodedMuxFrameSize,
  MAX_MUX_FRAME_BYTES,
  MAX_MUX_FRAME_PLAINTEXT_BYTES,
  RELAY_HOST_LEG_PREFIX_BYTES,
  MuxFrameSizeError,
  MuxFrameType,
  QosClass,
  type EncodeMuxFrameInput,
} from "../mux";

/**
 * The Noise-ciphertext size budget: a mux frame encoded at exactly
 * {@link MAX_MUX_FRAME_PLAINTEXT_BYTES} must, once sealed through a real
 * `NoiseSession.encrypt` AND wrapped in the host uplink's
 * `[sid:u32][ciphertext]` demux framing, fit inside the relay's cap
 * (`workers/relay-do`'s `MAX_FRAME_BYTES`, mirrored here as
 * {@link MAX_MUX_FRAME_BYTES}) — the relay measures the WHOLE WebSocket
 * message before stripping the prefix, and a larger frame closes the whole
 * session. `assertMuxFrameFits`/`encodeMuxFrame` are the sender-side
 * enforcement of that plaintext budget; this suite pins that the budget is
 * actually sized correctly against Noise overhead + the host-leg prefix, and
 * that one byte over is rejected before any Noise involvement at all.
 */

const EMPTY_ASSOCIATED_DATA = new Uint8Array(0);
const enc = new TextEncoder();

async function establishSessionPair(): Promise<{
  initiator: NoiseSession;
  responder: NoiseSession;
}> {
  const hostStatic = generateStaticKeyPair();
  const prologue = enc.encode("remote-host/v1");
  const initiatorHandshake = await createInitiatorHandshake(
    hostStatic.publicKey,
    prologue,
  );
  const responderHandshake = await createResponderHandshake(
    hostStatic,
    prologue,
  );
  const msg0 = await initiatorHandshake.writeMessage(EMPTY_ASSOCIATED_DATA);
  await responderHandshake.readMessage(msg0);
  const msg1 = await responderHandshake.writeMessage(EMPTY_ASSOCIATED_DATA);
  await initiatorHandshake.readMessage(msg1);
  return {
    initiator: NoiseSession.fromHandshake(
      initiatorHandshake,
      DEFAULT_REPLAY_WINDOW_SIZE,
    ),
    responder: NoiseSession.fromHandshake(
      responderHandshake,
      DEFAULT_REPLAY_WINDOW_SIZE,
    ),
  };
}

/** Builds a frame whose encoded plaintext size lands exactly on `targetBytes`. */
function frameAtExactSize(targetBytes: number): EncodeMuxFrameInput {
  const base: EncodeMuxFrameInput = {
    type: MuxFrameType.STREAM_FRAME,
    streamId: 7,
    seq: 1,
    qos: QosClass.BULK,
    chunked: true,
    chunkFirst: true,
    chunkLast: false,
    json: null,
    binary: new Uint8Array(0),
  };
  const overhead = encodedMuxFrameSize(base);
  const binaryLen = targetBytes - overhead;
  if (binaryLen < 0) {
    throw new Error(
      `targetBytes ${targetBytes} is smaller than the frame's own overhead ${overhead}`,
    );
  }
  return { ...base, binary: new Uint8Array(binaryLen).fill(0xcd) };
}

/**
 * The host uplink's demux framing (`[sid:u32 BE][ciphertext]`), mirrored
 * from `session-fan-out`'s host-leg framing / the relay's `encodeHostFrame`.
 * The relay checks its 1 MiB cap against THIS whole message, not the bare
 * ciphertext.
 */
function encodeHostLegFrame(sid: number, ciphertext: Uint8Array): Uint8Array {
  const framed = new Uint8Array(RELAY_HOST_LEG_PREFIX_BYTES + ciphertext.length);
  new DataView(framed.buffer).setUint32(0, sid, false);
  framed.set(ciphertext, RELAY_HOST_LEG_PREFIX_BYTES);
  return framed;
}

describe("mux frame plaintext cap vs. relay ciphertext cap", () => {
  it("a frame at exactly MAX_MUX_FRAME_PLAINTEXT_BYTES seals and host-leg-frames within MAX_MUX_FRAME_BYTES", async () => {
    const frame = frameAtExactSize(MAX_MUX_FRAME_PLAINTEXT_BYTES);
    expect(encodedMuxFrameSize(frame)).toBe(MAX_MUX_FRAME_PLAINTEXT_BYTES);

    expect(() => assertMuxFrameFits(frame)).not.toThrow();
    const plaintext = encodeMuxFrame(frame);
    expect(plaintext.length).toBe(MAX_MUX_FRAME_PLAINTEXT_BYTES);

    const { initiator } = await establishSessionPair();
    const ciphertext = await initiator.encrypt(plaintext, EMPTY_ASSOCIATED_DATA);
    const hostLeg = encodeHostLegFrame(0xdeadbeef, ciphertext);
    expect(hostLeg.length).toBeLessThanOrEqual(MAX_MUX_FRAME_BYTES);
    // The budget is exact, not merely sufficient: the three constants tile
    // the relay cap with no slack, so a drift in any one of them fails here.
    expect(hostLeg.length).toBe(MAX_MUX_FRAME_BYTES);
  });

  it("one byte over MAX_MUX_FRAME_PLAINTEXT_BYTES is rejected before any Noise involvement", () => {
    const frame = frameAtExactSize(MAX_MUX_FRAME_PLAINTEXT_BYTES + 1);
    expect(encodedMuxFrameSize(frame)).toBe(MAX_MUX_FRAME_PLAINTEXT_BYTES + 1);

    expect(() => assertMuxFrameFits(frame)).toThrow(MuxFrameSizeError);
    expect(() => encodeMuxFrame(frame)).toThrow(MuxFrameSizeError);
  });
});
