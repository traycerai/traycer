/**
 * A pair of connected {@link BridgeTransport}s, for driving the real endpoints without a real `Worker`.
 * The point of this harness is that it is not a mock of the boundary - it is a boundary.
 */
import type { BridgeTransport } from "../bridge-endpoint";

export interface RecordedPost {
  /** The frame as delivered (the clone), which is what the receiving endpoint actually saw. */
  readonly delivered: unknown;
  /**
   * The buffers the sender handed over.
   * Recorded before the clone, because a transferred buffer is detached by the time the clone returns and its `byteLength` reads 0 afterwards.
   */
  readonly transferredByteLengths: readonly number[];
  readonly transferCount: number;
}

export interface FakeBridgePair {
  readonly main: BridgeTransport;
  readonly worker: BridgeTransport;
  /** Frames the main side posted, in order. */
  readonly fromMain: readonly RecordedPost[];
  /** Frames the worker side posted, in order. */
  readonly fromWorker: readonly RecordedPost[];
  /**
   * Delivers everything queued, and everything that delivery causes.
   * A no-op in `"sync"` mode; in `"queued"` mode this is the only thing that moves a frame, which is how a test controls interleaving (two calls in flight, answered in the wrong order).
   */
  flush(): Promise<void>;
  /** Stops delivery in both directions, as a terminated worker would. */
  sever(): void;
  /**
   * Change how frames are delivered from this point on.
   * Construct on `"sync"`, flip after composition.
   */
  setDelivery(next: FakeBridgeDelivery): void;
}

export type FakeBridgeDelivery = "sync" | "queued";

/** Enough rounds for any legitimate call/reply chain; a bound, not a budget. */
const MAX_FLUSH_ROUNDS = 50;

export function createFakeBridgePair(
  delivery: FakeBridgeDelivery,
): FakeBridgePair {
  const fromMain: RecordedPost[] = [];
  const fromWorker: RecordedPost[] = [];
  const queue: Array<() => void> = [];
  let severed = false;
  // Mutable for the constructor-composition reason documented on `setDelivery`.
  // Read at each delivery rather than captured, so a flip applies to every frame after it and to none before.
  let deliveryMode: FakeBridgeDelivery = delivery;

  const mainListeners = new Set<(message: unknown) => void>();
  const workerListeners = new Set<(message: unknown) => void>();

  function makeSide(
    record: RecordedPost[],
    own: Set<(message: unknown) => void>,
    peers: Set<(message: unknown) => void>,
  ): BridgeTransport {
    return {
      post(message, transfer): void {
        if (severed) return;
        const transferredByteLengths = transfer.map(
          (buffer) => buffer.byteLength,
        );
        const delivered: unknown = structuredClone(message, {
          transfer: [...transfer],
        });
        record.push({
          delivered,
          transferredByteLengths,
          transferCount: transfer.length,
        });
        const deliver = (): void => {
          if (severed) return;
          // A copy of the listener set: a listener that unsubscribes during dispatch (the endpoint's own dispose does exactly this) must not mutate the collection being walked.
          for (const listener of [...peers]) listener(delivered);
        };
        if (deliveryMode === "sync") {
          deliver();
          return;
        }
        queue.push(deliver);
      },
      subscribe(listener): () => void {
        own.add(listener);
        return () => {
          own.delete(listener);
        };
      },
    };
  }

  // Each side records its own posts, receives on its own listener set, and
  // delivers into the other's - the crossover is the whole wiring.
  const main = makeSide(fromMain, mainListeners, workerListeners);
  const worker = makeSide(fromWorker, workerListeners, mainListeners);

  return {
    main,
    worker,
    fromMain,
    fromWorker,
    async flush(): Promise<void> {
      // Round-based rather than a single pass: a delivery enqueues more work (a call answered inside a handler), and that work only appears after the handler's promise has run.
      // The test that noticed did not report a missing reply - it timed out, twenty seconds later, pointing at the production call rather than at this line.
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        const batch = queue.splice(0, queue.length);
        for (const deliver of batch) deliver();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        if (queue.length === 0) return;
      }
      // A bound, not a safety net: a pipe that never settles means the code under test is posting in a loop, and a harness that spun forever would report it as a timeout somewhere unrelated.
      throw new Error(
        `fake bridge pair: still delivering after ${String(MAX_FLUSH_ROUNDS)} rounds`,
      );
    },
    setDelivery(next): void {
      deliveryMode = next;
    },
    sever(): void {
      severed = true;
      queue.length = 0;
    },
  };
}
