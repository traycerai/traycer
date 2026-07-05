import { describe, expect, it } from "vitest";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseDecryptError,
  NoiseSession,
  DEFAULT_REPLAY_WINDOW_SIZE,
} from "@traycer/protocol/crypto/noise";
import { TRANSPORT_HEADER_LEN, TAG_LEN } from "../../crypto/noise/constants";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  encodedMuxFrameSize,
  MuxFrameType,
  QosClass,
  type EncodeMuxFrameInput,
} from "../mux";

/**
 * AEAD associated-data invariant (S5 / fix #5, mechanism 3; architecture §3,
 * §4). Per the mux layering contract (`../mux.ts` header comment), the ONLY
 * thing the relay/host-leg framing ever puts outside the Noise ciphertext is
 * `sid` (+ the transport suite-version byte) — every mux field (`type`,
 * `streamId`, `seq`, `qos`/flags, `json`, `binary`) is folded into the
 * plaintext that gets encrypted whole. Both production channels
 * (`traycer-host/src/transport/remote/noise-responder.ts` and
 * `clients/shared/host-transport/remote/noise-channel.ts`) call
 * `NoiseSession.encrypt`/`decrypt` with an EMPTY associated-data array — that
 * is correct *only* as long as the invariant above holds. This suite pins it:
 *
 *  - "wire shape" cases assert the transport frame's only plaintext bytes are
 *    `[v:1][counter:8]` (`TRANSPORT_HEADER_LEN`) for a battery of mux frames
 *    spanning every `MuxFrameType`, streamId/seq values, and json/binary
 *    payloads — i.e. no mux field is ever duplicated outside the ciphertext.
 *  - the AD-mismatch case proves the associated-data parameter is genuinely
 *    load-bearing (encrypt/decrypt reject a mismatched AD), so if a future
 *    change ever DOES externalize a mux field, binding it via AD is a real,
 *    enforced fix rather than a parameter nobody checks.
 *
 * If this suite ever needs to change because a mux field starts appearing
 * outside `TRANSPORT_HEADER_LEN`, that is the systemic drift this ticket
 * exists to catch — the fix is to either move the field back inside the
 * encrypted payload, or bind it via associated data (not to relax this test).
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

const REPRESENTATIVE_MUX_FRAMES: readonly EncodeMuxFrameInput[] = [
  {
    type: MuxFrameType.OPEN,
    streamId: 0,
    seq: 1,
    qos: QosClass.INTERACTIVE,
    chunked: false,
    chunkLast: false,
    json: { bearer: "secret-bearer-marker" },
    binary: null,
  },
  {
    type: MuxFrameType.REQUEST,
    streamId: 42,
    seq: 7,
    qos: QosClass.INTERACTIVE,
    chunked: false,
    chunkLast: false,
    json: { requestId: "req-1", method: "host.status" },
    binary: null,
  },
  {
    type: MuxFrameType.STREAM_FRAME,
    streamId: 0xdeadbeef,
    seq: 0xffff,
    qos: QosClass.BULK,
    chunked: true,
    chunkLast: false,
    json: null,
    binary: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]),
  },
  {
    type: MuxFrameType.CREDIT,
    streamId: 5,
    seq: 99,
    qos: QosClass.BULK,
    chunked: true,
    chunkLast: true,
    json: { credits: 65536 },
    binary: new Uint8Array(512).fill(0xab),
  },
  {
    type: MuxFrameType.FATAL,
    streamId: 3,
    seq: 2,
    qos: QosClass.INTERACTIVE,
    chunked: false,
    chunkLast: false,
    json: { details: { code: "STREAM_SEQ_MISMATCH" } },
    binary: null,
  },
];

describe("AEAD associated-data invariant: no mux field is externalized without AD", () => {
  it.each(REPRESENTATIVE_MUX_FRAMES.map((frame, index) => [index, frame] as const))(
    "frame #%i: the transport wire frame's only plaintext bytes are [v, counter] — every mux field requires the session key to recover",
    async (_index, frame) => {
      const { initiator, responder } = await establishSessionPair();
      const plaintext = encodeMuxFrame(frame);
      const wireFrame = await initiator.encrypt(
        plaintext,
        EMPTY_ASSOCIATED_DATA,
      );

      // Structural check: header + ciphertext + tag, nothing more. If a
      // routing field were ever pulled out of the mux frame and appended/
      // prepended to the wire frame, this length would grow and this
      // assertion would catch it immediately.
      expect(wireFrame.length).toBe(
        TRANSPORT_HEADER_LEN + encodedMuxFrameSize(frame) + TAG_LEN,
      );

      // The only plaintext-visible bytes are the suite version + counter;
      // neither encodes any mux field (type/streamId/seq/json/binary).
      const header = wireFrame.slice(0, TRANSPORT_HEADER_LEN);
      expect(header[0]).toBe(1); // NOISE_SUITE_V1
      expect(header.length).toBe(TRANSPORT_HEADER_LEN);

      // The mux content is only recoverable by decrypting with the paired
      // session and the SAME (here: empty) associated data.
      const recoveredPlaintext = await responder.decrypt(
        wireFrame,
        EMPTY_ASSOCIATED_DATA,
      );
      expect(decodeMuxFrame(recoveredPlaintext)).toEqual(
        decodeMuxFrame(plaintext),
      );
    },
  );

  it("decrypting with a different session's key fails closed (mux content is never recoverable off-path)", async () => {
    const { initiator } = await establishSessionPair();
    const { responder: unrelatedResponder } = await establishSessionPair();
    const plaintext = encodeMuxFrame(REPRESENTATIVE_MUX_FRAMES[0]);
    const wireFrame = await initiator.encrypt(plaintext, EMPTY_ASSOCIATED_DATA);

    await expect(
      unrelatedResponder.decrypt(wireFrame, EMPTY_ASSOCIATED_DATA),
    ).rejects.toThrow(NoiseDecryptError);
  });

  it("associated data is genuinely load-bearing: matching AD decrypts, any mismatch (including empty) fails closed", async () => {
    const { initiator, responder } = await establishSessionPair();
    const plaintext = encodeMuxFrame(REPRESENTATIVE_MUX_FRAMES[0]);
    const routingTagUsedAtEncrypt = new Uint8Array([1, 2, 3, 4]);
    const wireFrame = await initiator.encrypt(
      plaintext,
      routingTagUsedAtEncrypt,
    );

    // A future change that externalizes a mux/routing field would bind it
    // via AD like `routingTagUsedAtEncrypt` above — this proves that binding
    // is actually enforced, not a parameter nobody checks:
    await expect(
      responder.decrypt(wireFrame, new Uint8Array([9, 9, 9, 9])),
    ).rejects.toThrow(NoiseDecryptError);
    await expect(
      responder.decrypt(wireFrame, EMPTY_ASSOCIATED_DATA),
    ).rejects.toThrow(NoiseDecryptError);

    // Same AD at decrypt time as at encrypt time: succeeds.
    await expect(
      responder.decrypt(wireFrame, routingTagUsedAtEncrypt),
    ).resolves.toEqual(plaintext);
  });
});
