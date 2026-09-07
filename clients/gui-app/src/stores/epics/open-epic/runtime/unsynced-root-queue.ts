/** Local root-doc updates produced while the renderer↔host transport is down. */
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
   * Bytes appended since the last collapse. The collapse trigger MUST be measured against this
   * rather than against the queue's total size.
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
