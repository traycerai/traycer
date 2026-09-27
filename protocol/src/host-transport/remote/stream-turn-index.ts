import type { OutboundChunkSource } from "../chunking";

/** One queued logical message, ordered against both QoS classes by `serial`. */
export interface StreamTurnItem {
  readonly source: OutboundChunkSource;
  readonly serial: number;
}

/** The flat inventory is unordered; `queueIndex` makes removals constant-time. */
export interface IndexedStreamTurnItem extends StreamTurnItem {
  queueIndex: number;
}

export function removeIndexedItem<T extends IndexedStreamTurnItem>(
  queue: T[],
  item: T,
): void {
  const index = item.queueIndex;
  if (queue[index] !== item) {
    throw new Error("stream turn item missing from class inventory");
  }
  const last = queue.pop();
  if (last === undefined) {
    throw new Error("stream turn class inventory is empty");
  }
  if (last !== item) {
    queue[index] = last;
    last.queueIndex = index;
  }
  item.queueIndex = -1;
}

interface StreamGroup<T> {
  entries: T[];
  front: number;
}

/**
 * A round-robin view of a class queue's per-stream FIFO heads.
 *
 * The schedulers retain their flat queues for debt, diagnostics and purges,
 * but a chunk turn must not walk or rewrite a stream's potentially large tail.
 * Map insertion order is the turn order; moving one group to the back is O(1)
 * regardless of how many messages are waiting behind its head.
 */
export class StreamTurnIndex<T extends StreamTurnItem> {
  private readonly groups = new Map<number, StreamGroup<T>>();

  enqueue(item: T): void {
    const streamId = item.source.streamId;
    const group = this.groups.get(streamId);
    if (group === undefined) {
      this.groups.set(streamId, { entries: [item], front: 0 });
    } else {
      group.entries.push(item);
    }
  }

  /** Visits one oldest message per stream, independent of each stream's tail. */
  *heads(): IterableIterator<T> {
    for (const group of this.groups.values()) {
      yield group.entries[group.front];
    }
  }

  headSerial(streamId: number): number | undefined {
    const group = this.groups.get(streamId);
    return group?.entries[group.front].serial;
  }

  /** A partial message keeps its FIFO head but yields the next stream's turn. */
  rotate(streamId: number): void {
    if (this.groups.size <= 1) return;
    const group = this.groups.get(streamId);
    if (group === undefined) return;
    this.groups.delete(streamId);
    this.groups.set(streamId, group);
  }

  /** Called only after the oldest message for this stream emitted its last frame. */
  complete(item: T): void {
    const streamId = item.source.streamId;
    const group = this.groups.get(streamId);
    if (group === undefined || group.entries[group.front] !== item) {
      throw new Error("stream turn index lost its FIFO head");
    }
    group.front += 1;
    if (group.front === group.entries.length) {
      this.groups.delete(streamId);
    } else if (group.front >= 32 && group.front * 2 >= group.entries.length) {
      // A long-lived stream's consumed prefix must not retain drained items.
      group.entries.splice(0, group.front);
      group.front = 0;
    }
  }

  dropStream(streamId: number): void {
    this.groups.delete(streamId);
  }

  clear(): void {
    this.groups.clear();
  }
}
