/**
 * A pair of connected {@link BridgeTransport}s, for driving the REAL endpoints
 * without a real `Worker`.
 *
 * The point of this harness is that it is not a mock of the boundary - it is a
 * boundary. Every delivery goes through `structuredClone` WITH the sender's
 * transfer list, so the properties that only exist at a real `postMessage` are
 * all live here:
 *
 *   - a transferred `ArrayBuffer` genuinely detaches on the sending side, so a
 *     helper that transfers a buffer it does not own fails the way it would in
 *     production rather than passing because both sides share one object;
 *   - a payload that is not structured-cloneable throws at the post, which is
 *     the only way a test can catch a frame that smuggles a live `Y.Doc`, a
 *     function, or a class instance;
 *   - the receiver observes a COPY, so a test cannot accidentally assert on
 *     object identity across the boundary and read that as agreement.
 *
 * A mock port that handed the same object to the other side would pass every
 * one of those cases while proving none of them.
 */
import type { BridgeTransport } from "../bridge-endpoint";

export interface RecordedPost {
  /**
   * The frame as delivered (the clone), which is what the receiving endpoint
   * actually saw. Asserting on the sender's object would read pre-transfer
   * state.
   */
  readonly delivered: unknown;
  /**
   * The buffers the sender handed over. Recorded before the clone, because a
   * transferred buffer is detached by the time the clone returns and its
   * `byteLength` reads 0 afterwards.
   */
  readonly transferredByteLengths: readonly number[];
  readonly transferCount: number;
}

export interface FakeBridgePair {
  readonly main: BridgeTransport;
  readonly worker: BridgeTransport;
  /** Frames the MAIN side posted, in order. */
  readonly fromMain: readonly RecordedPost[];
  /** Frames the WORKER side posted, in order. */
  readonly fromWorker: readonly RecordedPost[];
  /**
   * Delivers everything queued, and everything that delivery causes.
   *
   * A no-op in `"sync"` mode; in `"queued"` mode this is the only thing that
   * moves a frame, which is how a test controls interleaving (two calls in
   * flight, answered in the wrong order).
   *
   * Asynchronous, and it has to be. A call frame delivered to the worker is
   * answered from a promise handler, so the reply is posted a microtask later -
   * after a synchronous drain has already finished and would have reported the
   * pipe as settled. A test written against that would sit on a promise that
   * resolves only in a round nobody runs, and read as a hang in the code under
   * test rather than in the harness.
   */
  flush(): Promise<void>;
  /** Stops delivery in both directions, as a terminated worker would. */
  sever(): void;
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
          // A copy of the listener set: a listener that unsubscribes during
          // dispatch (the endpoint's own dispose does exactly this) must not
          // mutate the collection being walked.
          for (const listener of [...peers]) listener(delivered);
        };
        if (delivery === "sync") {
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
      // Round-based rather than a single pass: a delivery enqueues more work
      // (a call answered inside a handler), and that work only appears after
      // the handler's promise has run. Each round drains what is there, then
      // yields the microtask queue so the frames those deliveries produce are
      // enqueued before the next round looks.
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        const batch = queue.splice(0, queue.length);
        for (const deliver of batch) deliver();
        await Promise.resolve();
        await Promise.resolve();
        if (queue.length === 0) return;
      }
      // A bound, not a safety net: a pipe that never settles means the code
      // under test is posting in a loop, and a harness that spun forever would
      // report it as a timeout somewhere unrelated.
      throw new Error(
        `fake bridge pair: still delivering after ${String(MAX_FLUSH_ROUNDS)} rounds`,
      );
    },
    sever(): void {
      severed = true;
      queue.length = 0;
    },
  };
}
