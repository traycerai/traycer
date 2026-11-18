/**
 * Local root-doc updates produced while the renderer↔host transport is down.
 *
 * Re-homed from three closure `let`s and four closures. The logic is unchanged
 * down to the latch; what moved is ownership, so the queue can be handed to a
 * replica that survives a transport detach instead of living beside the socket
 * that dropped.
 *
 * Collapsed with `Y.mergeUpdates` once it grows past either threshold below.
 * The merge is lossless, and a merged update is bounded by the document's own
 * size rather than by how many edits produced it - so a long offline stretch
 * costs O(doc) instead of O(edits). Nothing is ever dropped: the queue is the
 * in-memory propagation path for edits the host has not seen, and discarding it
 * would lose user work that the reconnect reconcile is only a backstop for.
 */
import * as Y from "yjs";

const UNSYNCED_COLLAPSE_BYTES = 4 * 1024 * 1024;
const UNSYNCED_COLLAPSE_ENTRIES = 32;

export interface UnsyncedRootQueue {
  /** Logical edit count - what the UI reports as `unsyncedQueueSize`. */
  size(): number;
  /** Whether anything is buffered. Distinct from {@link size} only in intent. */
  isEmpty(): boolean;
  push(updateBytes: Uint8Array): void;
  /** Hand the buffered bytes to a caller about to send them, leaving it empty. */
  take(): Uint8Array[];
  clear(): void;
}

export function createUnsyncedRootQueue(): UnsyncedRootQueue {
  const queue: Uint8Array[] = [];
  /**
   * Logical edit count, tracked separately from the buffer because collapsing
   * must not make the UI under-report how much is unsynced.
   */
  let ops = 0;
  /**
   * Bytes appended since the last collapse.
   *
   * The collapse trigger MUST be measured against this rather than against the
   * queue's total size. A merged buffer is frequently larger than the
   * threshold all by itself, so a total-size trigger never falls back below
   * the line once it is crossed: every subsequent push would see a
   * two-element, over-threshold queue and re-merge the entire buffer, turning
   * an occasional O(doc) collapse into an O(doc) merge on every single edit.
   * Resetting this to zero after each merge is what makes the trigger latch.
   */
  let bytesSinceCollapse = 0;

  function clear(): void {
    queue.length = 0;
    ops = 0;
    bytesSinceCollapse = 0;
  }

  return {
    size(): number {
      return ops;
    },
    isEmpty(): boolean {
      return queue.length === 0;
    },
    push(updateBytes: Uint8Array): void {
      queue.push(updateBytes);
      ops += 1;
      bytesSinceCollapse += updateBytes.byteLength;
      if (queue.length < 2) return;
      if (
        bytesSinceCollapse <= UNSYNCED_COLLAPSE_BYTES &&
        queue.length <= UNSYNCED_COLLAPSE_ENTRIES
      ) {
        return;
      }
      const merged = Y.mergeUpdates(queue);
      queue.length = 0;
      queue.push(merged);
      bytesSinceCollapse = 0;
    },
    take(): Uint8Array[] {
      const pending = queue.slice();
      clear();
      return pending;
    },
    clear,
  };
}
