import { describe, expect, it, vi } from "vitest";
import { MuxFrameType, QosClass, type QosClassValue } from "../../mux";
import {
  BULK_CHUNK_SIZE_BYTES,
  ChunkInterleaveWindow,
  MAX_ACTIVE_CHUNKED_STREAMS,
  OutboundChunkSource,
} from "../../chunking";
import { removeIndexedItem, StreamTurnIndex } from "../stream-turn-index";
import type {
  IndexedStreamTurnItem,
  StreamTurnItem,
} from "../stream-turn-index";

function queued(streamId: number, serial: number): StreamTurnItem {
  let seq = 0;
  return {
    serial,
    source: new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        qos: QosClass.INTERACTIVE,
        json: { serial },
        binary: null,
      },
      () => seq++,
      false,
    ),
  };
}

function queuedChunked(
  streamId: number,
  serial: number,
  totalBodyBytes: number,
  qos: QosClassValue,
): StreamTurnItem {
  let seq = 0;
  return {
    serial,
    source: new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        qos,
        json: null,
        binary: new Uint8Array(totalBodyBytes - 5),
      },
      () => seq++,
      false,
    ),
  };
}

function startAndDrainChunked(
  index: StreamTurnIndex<StreamTurnItem>,
  window: ChunkInterleaveWindow,
  item: StreamTurnItem,
): void {
  expect(item.source.chunked).toBe(true);
  expect(index.canPull(item, window)).toBe(true);
  item.source.nextFrame();
  window.notePulled(item.source);
  index.noteChunkStarted(item.source.streamId);
  while (!item.source.done) {
    item.source.nextFrame();
    window.notePulled(item.source);
  }
  index.complete(item);
}

describe("StreamTurnIndex", () => {
  it("visits one head per stream regardless of a deep same-stream tail", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const first = queued(1, 1);
    const tail = Array.from({ length: 1000 }, (_, offset) =>
      queued(1, offset + 2),
    );
    const other = queued(2, 1002);

    index.enqueue(first);
    for (const item of tail) index.enqueue(item);
    index.enqueue(other);

    expect(Array.from(index.heads())).toEqual([first, other]);
    index.rotate(1);
    expect(Array.from(index.heads())).toEqual([other, first]);
    index.rotate(2);
    expect(Array.from(index.heads())).toEqual([first, other]);
    expect(index.headSerial(1)).toBe(first.serial);
  });

  it("advances and drops only the requested stream while keeping FIFO heads", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const first = queued(1, 1);
    const second = queued(1, 2);
    const third = queued(1, 3);
    const other = queued(2, 4);
    index.enqueue(first);
    index.enqueue(second);
    index.enqueue(third);
    index.enqueue(other);

    expect(Array.from(index.heads())).toEqual([first, other]);
    index.complete(first);
    expect(index.headSerial(1)).toBe(second.serial);
    expect(Array.from(index.heads())).toEqual([other, second]);

    index.dropStream(2);
    expect(Array.from(index.heads())).toEqual([second]);
    index.complete(second);
    expect(Array.from(index.heads())).toEqual([third]);
    index.complete(third);
    expect(Array.from(index.heads())).toEqual([]);
    expect(index.headSerial(1)).toBeUndefined();
  });

  it("removes an indexed inventory item by moving and reindexing the last item", () => {
    const first = { ...queued(1, 1), queueIndex: 0 };
    const middle = { ...queued(2, 2), queueIndex: 1 };
    const last = { ...queued(3, 3), queueIndex: 2 };
    const inventory: IndexedStreamTurnItem[] = [first, middle, last];

    removeIndexedItem(inventory, middle);
    expect(inventory).toEqual([first, last]);
    expect(middle.queueIndex).toBe(-1);
    expect(last.queueIndex).toBe(1);

    removeIndexedItem(inventory, last);
    expect(inventory).toEqual([first]);
    expect(last.queueIndex).toBe(-1);
    expect(first.queueIndex).toBe(0);
  });

  it("yields a nonempty stream after completion so replenishment cannot starve peers", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const a1 = queued(1, 1);
    const a2 = queued(1, 2);
    const a3 = queued(1, 3);
    const b1 = queued(2, 4);
    const b2 = queued(2, 5);
    for (const item of [a1, b1, a2, a3, b2]) index.enqueue(item);

    expect(Array.from(index.heads())).toEqual([a1, b1]);
    index.complete(a1);
    expect(Array.from(index.heads())).toEqual([b1, a2]);

    index.complete(b1);
    expect(Array.from(index.heads())).toEqual([a2, b2]);
    index.complete(a2);
    expect(Array.from(index.heads())).toEqual([b2, a3]);
  });

  it("clears completed body references before prefix compaction", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const first = queued(1, 1);
    const second = queued(1, 2);
    index.enqueue(first);
    index.enqueue(second);

    index.complete(first);

    const groups: unknown = Reflect.get(index, "groups");
    if (!(groups instanceof Map)) {
      throw new Error("expected stream groups to be a Map");
    }
    const group: unknown = groups.get(1);
    if (typeof group !== "object" || group === null) {
      throw new Error("expected the stream group to remain queued");
    }
    expect(Reflect.get(group, "entries")).toEqual([undefined, second]);
  });

  it("keeps window-deferred heads discoverable and reactivates them after a release", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    const active = Array.from({ length: MAX_ACTIVE_CHUNKED_STREAMS }, (_, i) =>
      queuedChunked(
        100 + i,
        100 + i,
        BULK_CHUNK_SIZE_BYTES + 5,
        QosClass.INTERACTIVE,
      ),
    );
    for (const item of active) {
      expect(item.source.chunked).toBe(true);
      expect(window.canPull(item.source)).toBe(true);
      item.source.nextFrame();
      window.notePulled(item.source);
    }
    const parked = queuedChunked(
      500,
      500,
      BULK_CHUNK_SIZE_BYTES + 5,
      QosClass.INTERACTIVE,
    );
    const dropped = queuedChunked(
      501,
      501,
      BULK_CHUNK_SIZE_BYTES + 5,
      QosClass.INTERACTIVE,
    );
    index.enqueue(parked);
    index.enqueue(dropped);
    index.deferForWindow(parked);
    index.deferForWindow(dropped);

    expect(Array.from(index.heads())).toEqual([]);
    expect(index.headSerial(parked.source.streamId)).toBe(parked.serial);
    index.dropStream(dropped.source.streamId);
    expect(index.headSerial(dropped.source.streamId)).toBeUndefined();

    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([]);
    window.forgetStream(active[0].source.streamId);
    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([parked]);
  });

  it("promotes the oldest fitting deferred head after a large waiter leaves only 1 MiB", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots").mockReturnValue(
      MAX_ACTIVE_CHUNKED_STREAMS,
    );
    vi.spyOn(window, "availableStartBytes").mockReturnValue(3 * 1024 * 1024);
    const largeWaiters = Array.from({ length: 16 }, (_, index) =>
      queuedChunked(
        700 + index,
        700 + index,
        2 * 1024 * 1024,
        QosClass.INTERACTIVE,
      ),
    );
    const smallWaiter = queuedChunked(
      800,
      800,
      128 * 1024,
      QosClass.INTERACTIVE,
    );
    const waiters = [...largeWaiters, smallWaiter];
    for (const item of waiters) {
      expect(item.source.chunked).toBe(true);
      index.enqueue(item);
      index.deferForWindow(item);
    }

    index.reconsiderWindow(window);

    expect(Array.from(index.heads())).toEqual([largeWaiters[0], smallWaiter]);
    for (const item of largeWaiters.slice(1)) {
      expect(index.headSerial(item.source.streamId)).toBe(item.serial);
    }
  });

  it("waits for every older other-queue head before waking a FIFO successor", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const successor = queued(42, 7);
    index.enqueue(successor);
    index.deferForOtherQueue(successor);

    expect(Array.from(index.heads())).toEqual([]);
    expect(index.headSerial(successor.source.streamId)).toBe(successor.serial);

    index.unblockFromOtherQueue(successor.source.streamId, 5);
    expect(Array.from(index.heads())).toEqual([]);
    expect(index.headSerial(successor.source.streamId)).toBe(successor.serial);

    index.unblockFromOtherQueue(successor.source.streamId, 6);
    expect(Array.from(index.heads())).toEqual([]);
    index.unblockFromOtherQueue(successor.source.streamId, undefined);
    expect(Array.from(index.heads())).toEqual([successor]);
  });

  it("re-defers an oversized promoted BULK head and exposes a fitting later head", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots").mockReturnValue(
      MAX_ACTIVE_CHUNKED_STREAMS - 1,
    );
    vi.spyOn(window, "availableStartBytes").mockReturnValue(1024 * 1024);
    const large = queuedChunked(900, 900, 2 * 1024 * 1024, QosClass.BULK);
    const small = queuedChunked(901, 901, 128 * 1024, QosClass.BULK);
    index.enqueue(large);
    index.deferForOtherQueue(large);
    index.enqueue(small);
    index.deferForWindow(small);

    index.unblockFromOtherQueue(large.source.streamId, undefined);
    index.reconsiderWindow(window);

    expect(Array.from(index.heads())).toEqual([small]);
    expect(index.headSerial(large.source.streamId)).toBe(large.serial);
  });

  it("reselects the oldest fitting waiter when an unsent promotion loses its budget", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots")
      .mockReturnValueOnce(2)
      .mockReturnValue(1);
    vi.spyOn(window, "availableStartBytes")
      .mockReturnValueOnce(256 * 1024)
      .mockReturnValue(1024 * 1024);
    const large = queuedChunked(1000, 1000, 1024 * 1024, QosClass.INTERACTIVE);
    const small1 = queuedChunked(1001, 1001, 128 * 1024, QosClass.INTERACTIVE);
    const small2 = queuedChunked(1002, 1002, 128 * 1024, QosClass.INTERACTIVE);
    for (const item of [large, small1, small2]) {
      index.enqueue(item);
      index.deferForWindow(item);
    }

    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([small1, small2]);

    // No promoted source was pulled. A changed budget must return those stale
    // promotions to the order index before selecting the oldest fitting head.
    index.reconsiderWindow(window);

    expect(Array.from(index.heads())).toEqual([large]);
    expect(index.headSerial(small1.source.streamId)).toBe(small1.serial);
    expect(index.headSerial(small2.source.streamId)).toBe(small2.serial);
  });

  it("reselects an older waiter after two small promotions were left unsent", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots")
      .mockReturnValueOnce(2)
      .mockReturnValue(1);
    vi.spyOn(window, "availableStartBytes")
      .mockReturnValueOnce(256 * 1024)
      .mockReturnValue(1024 * 1024);
    const large = queuedChunked(1100, 1100, 1024 * 1024, QosClass.INTERACTIVE);
    const small1 = queuedChunked(1101, 1101, 128 * 1024, QosClass.INTERACTIVE);
    const small2 = queuedChunked(1102, 1102, 128 * 1024, QosClass.INTERACTIVE);
    for (const item of [large, small1, small2]) {
      index.enqueue(item);
      index.deferForWindow(item);
    }

    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([small1, small2]);

    // The small heads were promoted while paced and remain unsent. A release
    // opens a 1 MiB window, where the older large source now fits first.
    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([large]);
    expect(index.headSerial(small1.source.streamId)).toBe(small1.serial);
    expect(index.headSerial(small2.source.streamId)).toBe(small2.serial);
  });

  it("gives the oldest waiter exclusive admission after 16 actual younger starts", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots").mockReturnValue(1);
    const availableBytes = vi
      .spyOn(window, "availableStartBytes")
      .mockReturnValue(128 * 1024);
    const oldest = queuedChunked(1200, 1200, 1024 * 1024, QosClass.INTERACTIVE);
    index.enqueue(oldest);
    index.deferForWindow(oldest);

    for (let count = 0; count < MAX_ACTIVE_CHUNKED_STREAMS; count += 1) {
      const small = queuedChunked(
        1300 + count,
        1300 + count,
        128 * 1024,
        QosClass.INTERACTIVE,
      );
      index.enqueue(small);
      startAndDrainChunked(index, window, small);
    }

    const nextSmall = queuedChunked(
      1400,
      1400,
      128 * 1024,
      QosClass.INTERACTIVE,
    );
    index.enqueue(nextSmall);
    expect(index.canPull(nextSmall, window)).toBe(false);
    index.deferForWindow(nextSmall);
    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([]);

    availableBytes.mockReturnValue(2 * 1024 * 1024);
    index.reconsiderWindow(window);
    expect(Array.from(index.heads())).toEqual([oldest]);
    expect(index.canPull(oldest, window)).toBe(true);

    oldest.source.nextFrame();
    window.notePulled(oldest.source);
    index.noteChunkStarted(oldest.source.streamId);
    expect(index.canPull(nextSmall, window)).toBe(true);
  });

  it("resets the bypass barrier when its oldest waiter is dropped", () => {
    const index = new StreamTurnIndex<StreamTurnItem>();
    const window = new ChunkInterleaveWindow();
    vi.spyOn(window, "availableStartSlots").mockReturnValue(1);
    vi.spyOn(window, "availableStartBytes").mockReturnValue(128 * 1024);
    const oldest = queuedChunked(1500, 1500, 1024 * 1024, QosClass.INTERACTIVE);
    index.enqueue(oldest);
    index.deferForWindow(oldest);
    for (let count = 0; count < MAX_ACTIVE_CHUNKED_STREAMS; count += 1) {
      const small = queuedChunked(
        1600 + count,
        1600 + count,
        128 * 1024,
        QosClass.INTERACTIVE,
      );
      index.enqueue(small);
      startAndDrainChunked(index, window, small);
    }
    const nextSmall = queuedChunked(
      1700,
      1700,
      128 * 1024,
      QosClass.INTERACTIVE,
    );
    index.enqueue(nextSmall);
    expect(index.canPull(nextSmall, window)).toBe(false);
    index.deferForWindow(nextSmall);

    expect(index.dropStream(oldest.source.streamId)).toBe(true);
    index.reconsiderWindow(window);

    expect(Array.from(index.heads())).toEqual([nextSmall]);
    expect(index.canPull(nextSmall, window)).toBe(true);
  });
});
