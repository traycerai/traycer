import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameDecodeError,
  MuxFrameType,
  QosClass,
} from "../../mux";
import {
  ChunkReassembler,
  ChunkReassemblyError,
  MuxFrameOverExpansionError,
} from "../../chunking";
import type { MuxFrame } from "../../mux";

/**
 * `RemoteSession.failStreamOnInboundError` (`../session.ts`) routes an
 * inbound chunk-reassembly fault one of two ways: a `MuxFrameOverExpansionError`
 * - a compressed frame that inflated to MORE bytes than its declared
 * plaintext length - falls through to the caller's re-throw and is routed to
 * `handleConnectionLost(generation, "inbound-decode-failed", ...)`, a SESSION
 * failure. Every other `MuxFrameDecodeError` / `ChunkReassemblyError` (e.g. a
 * payload that inflates to FEWER bytes than declared) is caught and routed
 * per-stream, as a `STREAM_BODY_DECODE_FAILED` fatal on that one stream,
 * leaving the session and every sibling stream untouched. The discriminator
 * is a single `if (error instanceof MuxFrameOverExpansionError) return false;`
 * inside that private method.
 *
 * WHAT THIS FILE DOES NOT DO, AND WHY:
 *
 * The obvious way to prove the routing is to build a live `RemoteSession`,
 * hand it a fake relay socket + Noise responder, complete the handshake, open
 * a stream, and deliver an encoded STREAM_FRAME for each of the two cases -
 * then assert one produces a session-level `connectionLost`/reconnect and the
 * other a per-stream `STREAM_BODY_DECODE_FAILED` fatal with the session still
 * up. No such harness exists anywhere in `protocol/`: there is no
 * `src/host-transport/remote/__tests__/` directory, and a repo-wide grep for
 * `new RemoteSession(` under `protocol/src` returns nothing - nothing here
 * ever constructs one. The one harness that DOES do exactly this
 * (`FakeRelayHost`, a real Noise handshake, `RemoteSession.subscribe`, an
 * encrypted `STREAM_FRAME` delivered end to end - see e.g. its "fails only
 * the corrupted stream on an undecodable COMPRESSED frame" case) lives at
 * `clients/shared/host-transport/remote/__tests__/remote-session.test.ts`,
 * is roughly 10,000 lines, and is outside `protocol/` entirely - out of
 * scope for this change, and reconstructing an equivalent inside `protocol/`
 * is exactly the large new scaffolding this test is deliberately avoiding.
 *
 * `failStreamOnInboundError` and its error-to-code mapping
 * (`streamInboundFailureCode`) are both private / module-unexported in
 * `session.ts`, so there is no lighter in-package public surface that invokes
 * the routing decision directly either - constructing a bare `RemoteSession`
 * just to reach the private method through bracket-notation access would
 * still need a full, type-satisfying `RemoteSessionOptions` (grant provider,
 * auth, websocket factory, branded RPC/stream registries, client identity,
 * ...), and even then the only branch reachable without a live connection is
 * the stale-generation short-circuit - not the real per-stream / per-session
 * side effects the task cares about. That would be a contrived edge case
 * dressed up as a proof, not the real thing.
 *
 * So instead this pins the actual discriminator the private method switches
 * on, produced by the REAL, exported, unmodified production code
 * (`ChunkReassembler.accept`, which is what `onData` in `session.ts` calls
 * before ever reaching `failStreamOnInboundError`) for the exact two fixture
 * shapes the routing exists to tell apart. If `inflateFramePayload` ever
 * stopped raising `MuxFrameOverExpansionError` specifically for an
 * over-expanding payload - or started raising it for an under-expanding one -
 * these tests fail even though nothing in `session.ts` changed, which is
 * exactly the regression that would silently break the routing.
 */
describe("session-level vs per-stream inbound decode routing", () => {
  function compressedStreamFrame(
    streamId: number,
    declaredPlainLength: number,
    deflated: Uint8Array,
  ): MuxFrame {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, declaredPlainLength);
    const payload = new Uint8Array(header.length + deflated.length);
    payload.set(header, 0);
    payload.set(deflated, header.length);
    return decodeMuxFrame(
      encodeMuxFrame({
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        seq: 0,
        qos: QosClass.BULK,
        chunked: false,
        chunkFirst: false,
        chunkLast: false,
        compressed: true,
        json: null,
        binary: payload,
      }),
    );
  }

  it("MuxFrameOverExpansionError is a MuxFrameDecodeError - the recognised-then-narrowed shape failStreamOnInboundError depends on", () => {
    // failStreamOnInboundError's first guard only recognises
    // ChunkReassemblyError / MuxMessageSizeError / MuxFrameDecodeError as
    // inbound faults it might route per-stream; only THEN does it narrow the
    // one session-level case out with `instanceof MuxFrameOverExpansionError`.
    // If the subclass relationship ever broke, that first guard would stop
    // recognising it too - a different code path landing on the same
    // session-level outcome, which is exactly the kind of coincidence that
    // makes the invariant worth pinning on its own.
    const error = new MuxFrameOverExpansionError("test over-expansion");
    expect(error).toBeInstanceOf(MuxFrameDecodeError);
    expect(error instanceof ChunkReassemblyError).toBe(false);
  });

  it("an over-expanding compressed frame raises MuxFrameOverExpansionError - the class failStreamOnInboundError routes to the SESSION", () => {
    // 1 MiB of zeros deflates to roughly 1 KiB. Declaring a plaintext length
    // just barely larger than the deflated payload - but far, far smaller
    // than the ~1 MiB the payload actually inflates to - is what
    // `inflateFramePayload` catches from ONE bounded `inflateSync` call: the
    // clamped output comes back full (`written > plainLength`), which is the
    // over-expansion verdict.
    const actualPlainLength = 1024 * 1024;
    const deflated = deflateSync(new Uint8Array(actualPlainLength), {
      level: 6,
    });
    const declaredPlainLength = 4 + deflated.length + 1;
    expect(declaredPlainLength).toBeLessThan(actualPlainLength);

    const frame = compressedStreamFrame(21, declaredPlainLength, deflated);
    const reassembler = new ChunkReassembler(undefined);

    let thrown: unknown = null;
    try {
      reassembler.accept(frame);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) {
      throw new Error("expected reassembler.accept to throw an Error");
    }
    // The SESSION-routed identity specifically, not merely "some decode
    // error" - `failStreamOnInboundError` only re-throws (session-level) for
    // this exact class.
    expect(thrown).toBeInstanceOf(MuxFrameOverExpansionError);
  });

  it("a compressed frame that inflates SHORT of its declaration raises a plain MuxFrameDecodeError - the class failStreamOnInboundError routes to only its STREAM", () => {
    // 1000 zero bytes deflates to well under 1000 bytes; declaring 5000
    // plaintext bytes means the single bounded inflate genuinely produces
    // only 1000 bytes (`written < plainLength`), which is the "declared more
    // than it delivered" verdict - a plain MuxFrameDecodeError, deliberately
    // NOT the over-expansion subclass.
    const actualPlainLength = 1000;
    const declaredPlainLength = 5000;
    const deflated = deflateSync(new Uint8Array(actualPlainLength), {
      level: 6,
    });
    expect(deflated.length).toBeLessThan(actualPlainLength);

    const frame = compressedStreamFrame(22, declaredPlainLength, deflated);
    const reassembler = new ChunkReassembler(undefined);

    let thrown: unknown = null;
    try {
      reassembler.accept(frame);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) {
      throw new Error("expected reassembler.accept to throw an Error");
    }
    expect(thrown).toBeInstanceOf(MuxFrameDecodeError);
    // The negative half of the discriminator: this is the class
    // `failStreamOnInboundError`'s `instanceof MuxFrameOverExpansionError`
    // check must NOT match, or a merely-short compressed frame would tear
    // down the whole session instead of failing its one stream.
    expect(thrown).not.toBeInstanceOf(MuxFrameOverExpansionError);
  });
});
