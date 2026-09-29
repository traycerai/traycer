import { afterEach, describe, expect, it, vi } from "vitest";
import { MuxFrameType, QosClass, type MuxFrame } from "../../mux";
import { RemoteTrafficAccounting } from "../traffic-accounting";

const TASK_ID = "12345678-1234-1234-1234-123456789012";
const CHAT_ID = "abcdefab-cdef-abcd-efab-cdefabcdefab";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RemoteTrafficAccounting", () => {
  it("reconciles every inbound frame and byte across stream, handshake, relay, and residual buckets", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const traffic = new RemoteTrafficAccounting();

    traffic.receiveBinary(17);
    traffic.classifyHandshake(17);
    traffic.receiveText(11);

    traffic.register(7, "cursor.subscribe", "stream", {
      taskId: TASK_ID,
      chatId: CHAT_ID,
    });
    const firstFrameAt = traffic.receiveBinary(100);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        seq: 0,
        qos: QosClass.BULK,
        chunked: false,
        chunkFirst: false,
        chunkLast: false,
        compressed: true,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      100,
      82,
      firstFrameAt,
    );
    const secondFrameAt = traffic.receiveBinary(120);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        seq: 1,
        qos: QosClass.BULK,
        chunked: false,
        chunkFirst: false,
        chunkLast: false,
        compressed: false,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      120,
      101,
      secondFrameAt,
    );

    // A frame for an unregistered stream stays visible in the residual rather
    // than vanishing from totals or creating a diagnostic row.
    traffic.receiveBinary(5);
    const snapshot = traffic.snapshot();

    expect(snapshot).toMatchObject({
      startedAt: 10_000,
      receivedBytes: 253,
      receivedFrames: 5,
      relayTextBytes: 11,
      relayTextFrames: 1,
      noiseHandshakeBytes: 17,
      noiseHandshakeFrames: 1,
      unclassifiedBinaryBytes: 5,
      unclassifiedBinaryFrames: 1,
      truncatedStreamRegistrations: 0,
      reconnects: 0,
    });
    expect(snapshot.streams).toEqual([
      {
        streamId: 7,
        method: "cursor.subscribe",
        kind: "stream",
        epic: TASK_ID,
        chat: CHAT_ID,
        firstMs: 0,
        lastMs: 0,
        ciphertextBytes: 220,
        muxBytes: 183,
        frames: 2,
        compressedFrames: 1,
        incomplete: false,
        reconnects: 0,
      },
    ]);

    const streamBytes = snapshot.streams.reduce(
      (total, row) => total + row.ciphertextBytes,
      0,
    );
    const streamFrames = snapshot.streams.reduce(
      (total, row) => total + row.frames,
      0,
    );
    expect(
      snapshot.relayTextBytes +
        snapshot.noiseHandshakeBytes +
        snapshot.unclassifiedBinaryBytes +
        streamBytes,
    ).toBe(snapshot.receivedBytes);
    expect(
      snapshot.relayTextFrames +
        snapshot.noiseHandshakeFrames +
        snapshot.unclassifiedBinaryFrames +
        streamFrames,
    ).toBe(snapshot.receivedFrames);
  });

  it("keeps a retired chunk row incomplete when a late final frame and later connection loss arrive", () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000);
    const traffic = new RemoteTrafficAccounting();
    const streamId = 9;
    traffic.register(streamId, "cursor.subscribe", "stream", null);

    const firstChunkAt = traffic.receiveBinary(80);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        seq: 0,
        qos: QosClass.BULK,
        chunked: true,
        chunkFirst: true,
        chunkLast: false,
        compressed: false,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      80,
      67,
      firstChunkAt,
    );
    traffic.end(streamId, true);

    // The transport retired this stream as incomplete, but the final chunk
    // was already in flight and reaches accounting afterward.
    const lateFinalChunkAt = traffic.receiveBinary(55);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        seq: 1,
        qos: QosClass.BULK,
        chunked: true,
        chunkFirst: false,
        chunkLast: true,
        compressed: false,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      55,
      42,
      lateFinalChunkAt,
    );
    traffic.connectionLost();

    const snapshot = traffic.snapshot();
    expect(snapshot.streams).toHaveLength(1);
    const [row] = snapshot.streams;
    if (row === undefined) throw new Error("expected the retired stream row");
    expect(snapshot).toMatchObject({
      receivedBytes: 135,
      receivedFrames: 2,
      unclassifiedBinaryBytes: 0,
      unclassifiedBinaryFrames: 0,
      reconnects: 1,
    });
    expect(row).toMatchObject({
      streamId,
      ciphertextBytes: 135,
      muxBytes: 109,
      frames: 2,
      incomplete: true,
      reconnects: 0,
    });
    expect(
      snapshot.unclassifiedBinaryBytes +
        snapshot.streams.reduce(
          (total, stream) => total + stream.ciphertextBytes,
          0,
        ),
    ).toBe(snapshot.receivedBytes);
    expect(
      snapshot.unclassifiedBinaryFrames +
        snapshot.streams.reduce((total, stream) => total + stream.frames, 0),
    ).toBe(snapshot.receivedFrames);
  });

  it("keeps a chunked row incomplete until the final chunk arrives, and counts only compressed chunks as compressed frames", () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000);
    const traffic = new RemoteTrafficAccounting();
    const streamId = 11;
    traffic.register(streamId, "cursor.subscribe", "stream", null);

    const firstChunkAt = traffic.receiveBinary(64);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        seq: 0,
        qos: QosClass.BULK,
        chunked: true,
        chunkFirst: true,
        chunkLast: false,
        compressed: true,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      64,
      50,
      firstChunkAt,
    );

    let snapshot = traffic.snapshot();
    let row = snapshot.streams.find(
      (candidate) => candidate.streamId === streamId,
    );
    if (row === undefined) throw new Error("expected the chunked stream row");
    expect(row.incomplete).toBe(true);
    expect(row.compressedFrames).toBe(1);
    expect(row.frames).toBe(1);

    const lastChunkAt = traffic.receiveBinary(48);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        seq: 1,
        qos: QosClass.BULK,
        chunked: true,
        chunkFirst: false,
        chunkLast: true,
        compressed: false,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      48,
      38,
      lastChunkAt,
    );

    snapshot = traffic.snapshot();
    row = snapshot.streams.find((candidate) => candidate.streamId === streamId);
    if (row === undefined) throw new Error("expected the chunked stream row");
    expect(row.incomplete).toBe(false);
    // Only the first chunk declared itself compressed; the second did not.
    expect(row.compressedFrames).toBe(1);
    expect(row.frames).toBe(2);

    const streamBytes = snapshot.streams.reduce(
      (total, stream) => total + stream.ciphertextBytes,
      0,
    );
    const streamFrames = snapshot.streams.reduce(
      (total, stream) => total + stream.frames,
      0,
    );
    expect(
      snapshot.relayTextBytes +
        snapshot.noiseHandshakeBytes +
        snapshot.unclassifiedBinaryBytes +
        streamBytes,
    ).toBe(snapshot.receivedBytes);
    expect(
      snapshot.relayTextFrames +
        snapshot.noiseHandshakeFrames +
        snapshot.unclassifiedBinaryFrames +
        streamFrames,
    ).toBe(snapshot.receivedFrames);
  });

  it("truncates stream registrations past the row cap into the unclassified residual, with totals still reconciling", () => {
    vi.spyOn(Date, "now").mockReturnValue(40_000);
    const traffic = new RemoteTrafficAccounting();
    const ROW_CAP = 1024;
    for (let streamId = 1; streamId <= ROW_CAP; streamId += 1) {
      traffic.register(streamId, "cursor.subscribe", "stream", null);
    }
    const overflowStreamId = ROW_CAP + 1;
    traffic.register(overflowStreamId, "cursor.subscribe", "stream", null);

    let snapshot = traffic.snapshot();
    expect(snapshot.streams).toHaveLength(ROW_CAP);
    expect(snapshot.truncatedStreamRegistrations).toBe(1);

    // A frame for the overflowed stream has no row to attribute to, so it
    // lands - and stays - in the unclassified residual instead of vanishing.
    const receivedAt = traffic.receiveBinary(77);
    traffic.classifyMux(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: overflowStreamId,
        seq: 0,
        qos: QosClass.INTERACTIVE,
        chunked: false,
        chunkFirst: false,
        chunkLast: false,
        compressed: false,
        json: null,
        binary: null,
      } satisfies MuxFrame,
      77,
      60,
      receivedAt,
    );

    snapshot = traffic.snapshot();
    expect(snapshot.unclassifiedBinaryBytes).toBe(77);
    expect(snapshot.unclassifiedBinaryFrames).toBe(1);
    expect(
      snapshot.streams.some((row) => row.streamId === overflowStreamId),
    ).toBe(false);

    const streamBytes = snapshot.streams.reduce(
      (total, stream) => total + stream.ciphertextBytes,
      0,
    );
    const streamFrames = snapshot.streams.reduce(
      (total, stream) => total + stream.frames,
      0,
    );
    expect(
      snapshot.relayTextBytes +
        snapshot.noiseHandshakeBytes +
        snapshot.unclassifiedBinaryBytes +
        streamBytes,
    ).toBe(snapshot.receivedBytes);
    expect(
      snapshot.relayTextFrames +
        snapshot.noiseHandshakeFrames +
        snapshot.unclassifiedBinaryFrames +
        streamFrames,
    ).toBe(snapshot.receivedFrames);
  });
});
