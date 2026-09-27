import type { ChunkInterleaveWindow, OutboundChunkSource } from "../chunking";

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
  /** Completed prefix slots are cleared immediately so their bodies can be collected. */
  entries: Array<T | undefined>;
  front: number;
  /** Retained across a promotion that could not pull after another admission. */
  deferredOrder: number | null;
}

/** Waiting heads keyed by turn order, with the smallest body in each subtree. */
interface DeferredNode {
  readonly streamId: number;
  readonly order: number;
  readonly bytes: number;
  readonly priority: number;
  minBytes: number;
  left: DeferredNode | null;
  right: DeferredNode | null;
}

function refreshMin(node: DeferredNode): void {
  node.minBytes = Math.min(
    node.bytes,
    node.left?.minBytes ?? Infinity,
    node.right?.minBytes ?? Infinity,
  );
}

function rotateRight(root: DeferredNode): DeferredNode {
  const left = root.left;
  if (left === null) throw new Error("missing deferred left child");
  root.left = left.right;
  left.right = root;
  refreshMin(root);
  refreshMin(left);
  return left;
}

function rotateLeft(root: DeferredNode): DeferredNode {
  const right = root.right;
  if (right === null) throw new Error("missing deferred right child");
  root.right = right.left;
  right.left = root;
  refreshMin(root);
  refreshMin(right);
  return right;
}

/** Internal monotonic orders are mixed into balanced tree priorities. */
function deferredPriority(order: number): number {
  let value = order ^ (order >>> 16);
  value = Math.imul(value, 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function insertDeferred(
  root: DeferredNode | null,
  node: DeferredNode,
): DeferredNode {
  if (root === null) return node;
  if (node.order === root.order) {
    throw new Error("duplicate deferred turn order");
  }
  if (node.order < root.order) {
    root.left = insertDeferred(root.left, node);
    if (root.left.priority < root.priority) root = rotateRight(root);
  } else {
    root.right = insertDeferred(root.right, node);
    if (root.right.priority < root.priority) root = rotateLeft(root);
  }
  refreshMin(root);
  return root;
}

function mergeDeferred(
  left: DeferredNode | null,
  right: DeferredNode | null,
): DeferredNode | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left.priority < right.priority) {
    left.right = mergeDeferred(left.right, right);
    refreshMin(left);
    return left;
  }
  right.left = mergeDeferred(left, right.left);
  refreshMin(right);
  return right;
}

function removeDeferred(
  root: DeferredNode | null,
  order: number,
): DeferredNode | null {
  if (root === null) throw new Error("missing deferred turn order");
  if (order === root.order) return mergeDeferred(root.left, root.right);
  if (order < root.order) {
    root.left = removeDeferred(root.left, order);
  } else {
    root.right = removeDeferred(root.right, order);
  }
  refreshMin(root);
  return root;
}

function firstFitting(
  root: DeferredNode | null,
  byteBudget: number,
): DeferredNode | null {
  if (root === null || root.minBytes > byteBudget) return null;
  if (root.left !== null && root.left.minBytes <= byteBudget) {
    return firstFitting(root.left, byteBudget);
  }
  if (root.bytes <= byteBudget) return root;
  return firstFitting(root.right, byteBudget);
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
  /** A released slot gives parked heads one turn before ready successors. */
  private readonly promoted = new Map<number, StreamGroup<T>>();
  /** Parked heads remain FIFO-visible without participating in each chunk scan. */
  private readonly deferred = new Map<number, StreamGroup<T>>();
  private readonly fifoDeferred = new Map<number, StreamGroup<T>>();
  private deferredRoot: DeferredNode | null = null;
  private nextDeferredOrder = 0;

  enqueue(item: T): void {
    const streamId = item.source.streamId;
    const group =
      this.groups.get(streamId) ??
      this.promoted.get(streamId) ??
      this.deferred.get(streamId) ??
      this.fifoDeferred.get(streamId);
    if (group === undefined) {
      this.groups.set(streamId, {
        entries: [item],
        front: 0,
        deferredOrder: null,
      });
    } else {
      group.entries.push(item);
    }
  }

  /** Visits one oldest message per stream, independent of each stream's tail. */
  *heads(): IterableIterator<T> {
    for (const group of this.promoted.values()) {
      const head = group.entries[group.front];
      if (head === undefined) {
        throw new Error("stream turn index lost its FIFO head");
      }
      yield head;
    }
    for (const group of this.groups.values()) {
      const head = group.entries[group.front];
      if (head === undefined) {
        throw new Error("stream turn index lost its FIFO head");
      }
      yield head;
    }
  }

  headSerial(streamId: number): number | undefined {
    const group =
      this.groups.get(streamId) ??
      this.promoted.get(streamId) ??
      this.deferred.get(streamId) ??
      this.fifoDeferred.get(streamId);
    return group?.entries[group.front]?.serial;
  }

  /** An older message in the other QoS queue must finish before this head. */
  deferForOtherQueue(item: T): void {
    const streamId = item.source.streamId;
    const group = this.groups.get(streamId) ?? this.promoted.get(streamId);
    if (group === undefined || group.entries[group.front] !== item) {
      throw new Error("stream turn index lost its FIFO head");
    }
    this.groups.delete(streamId);
    this.promoted.delete(streamId);
    this.fifoDeferred.set(streamId, group);
  }

  /** Wake only after no older head remains in the other QoS queue. */
  unblockFromOtherQueue(
    streamId: number,
    blockingSerial: number | undefined,
  ): void {
    const group = this.fifoDeferred.get(streamId);
    if (group === undefined) return;
    const head = group.entries[group.front];
    if (head === undefined) {
      throw new Error("stream turn index lost its FIFO head");
    }
    if (blockingSerial !== undefined && blockingSerial < head.serial) return;
    this.fifoDeferred.delete(streamId);
    this.promoted.set(streamId, group);
  }

  /** Window rejects a new partial body; index it by turn and required bytes. */
  deferForWindow(item: T): void {
    const streamId = item.source.streamId;
    const group = this.groups.get(streamId) ?? this.promoted.get(streamId);
    if (group === undefined || group.entries[group.front] !== item) {
      throw new Error("stream turn index lost its FIFO head");
    }
    this.groups.delete(streamId);
    this.promoted.delete(streamId);
    const order = group.deferredOrder ?? this.nextDeferredOrder++;
    group.deferredOrder = order;
    this.deferred.set(streamId, group);
    this.deferredRoot = insertDeferred(this.deferredRoot, {
      streamId,
      order,
      bytes: item.source.totalBodyBytes,
      priority: deferredPriority(order),
      minBytes: item.source.totalBodyBytes,
      left: null,
      right: null,
    });
  }

  /** Find oldest bodies that fit without scanning the blocked prefix. */
  reconsiderWindow(window: ChunkInterleaveWindow): void {
    for (const group of this.promoted.values()) {
      const head = group.entries[group.front];
      if (head === undefined)
        throw new Error("stream turn index lost its FIFO head");
      const source = head.source;
      if (
        source.chunked &&
        source.remainingBytes === source.totalBodyBytes &&
        !window.usesExistingReservation(source)
      ) {
        // Unsent promotions still compete with older deferred heads. Rebuild
        // that small cohort in turn order before reserving capacity again.
        this.deferForWindow(head);
      }
    }
    if (this.deferredRoot === null) return;
    const firstGroup = this.deferred.get(this.deferredRoot.streamId);
    // The tree root is priority-balanced, but identifies this class's QoS.
    const firstSource = firstGroup?.entries[firstGroup.front]?.source;
    if (firstSource === undefined) {
      throw new Error("stream turn index lost its deferred head");
    }
    let slots = window.availableStartSlots(firstSource.qos);
    let bytes = window.availableStartBytes(firstSource.qos);
    while (slots > 0) {
      const candidate = firstFitting(this.deferredRoot, bytes);
      if (candidate === null) break;
      const group = this.deferred.get(candidate.streamId);
      if (group === undefined) {
        throw new Error("stream turn index lost its deferred group");
      }
      this.deferredRoot = removeDeferred(this.deferredRoot, candidate.order);
      this.deferred.delete(candidate.streamId);
      this.promoted.set(candidate.streamId, group);
      slots -= 1;
      bytes -= candidate.bytes;
    }
  }

  /** A partial message keeps its FIFO head but yields the next stream's turn. */
  rotate(streamId: number): void {
    const promotedGroup = this.promoted.get(streamId);
    if (promotedGroup !== undefined) {
      this.promoted.delete(streamId);
      promotedGroup.deferredOrder = null;
      this.groups.set(streamId, promotedGroup);
      return;
    }
    if (this.groups.size <= 1) return;
    const group = this.groups.get(streamId);
    if (group === undefined) return;
    this.groups.delete(streamId);
    this.groups.set(streamId, group);
  }

  /** Called only after the oldest message for this stream emitted its last frame. */
  complete(item: T): void {
    const streamId = item.source.streamId;
    const group = this.groups.get(streamId) ?? this.promoted.get(streamId);
    if (group === undefined || group.entries[group.front] !== item) {
      throw new Error("stream turn index lost its FIFO head");
    }
    group.deferredOrder = null;
    group.entries[group.front] = undefined;
    group.front += 1;
    if (group.front === group.entries.length) {
      this.groups.delete(streamId);
      this.promoted.delete(streamId);
    } else {
      if (group.front >= 32 && group.front * 2 >= group.entries.length) {
        // The cleared prefix still has array capacity; compact it periodically.
        group.entries.splice(0, group.front);
        group.front = 0;
      }
      // A stream with another message ready must yield after a completed one
      // too, or a replenished stream can starve another stream indefinitely.
      this.rotate(streamId);
    }
  }

  dropStream(streamId: number): void {
    this.groups.delete(streamId);
    this.promoted.delete(streamId);
    const deferredGroup = this.deferred.get(streamId);
    if (deferredGroup !== undefined && deferredGroup.deferredOrder !== null) {
      this.deferredRoot = removeDeferred(
        this.deferredRoot,
        deferredGroup.deferredOrder,
      );
    }
    this.deferred.delete(streamId);
    this.fifoDeferred.delete(streamId);
  }

  clear(): void {
    this.groups.clear();
    this.promoted.clear();
    this.deferred.clear();
    this.fifoDeferred.clear();
    this.deferredRoot = null;
    this.nextDeferredOrder = 0;
  }
}
