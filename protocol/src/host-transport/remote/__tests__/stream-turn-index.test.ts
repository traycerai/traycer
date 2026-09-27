import { describe, expect, it } from "vitest";
import { MuxFrameType, QosClass } from "../../mux";
import { OutboundChunkSource } from "../../chunking";
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
});
