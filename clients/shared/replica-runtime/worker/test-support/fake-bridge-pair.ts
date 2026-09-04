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
  /**
   * Change how frames are delivered from this point on.
   *
   * It exists because a pair cannot be `"queued"` FROM BIRTH and still be
   * constructible: the runtime's composition is synchronous over this pipe -
   * `spawnEpicRuntimeWorker` publishes its bootstrap during the spawn call
   * itself - so a pipe that delivers nothing until `flush()` never hands the
   * bootstrap over, and the caller gets "the worker composed no runtime"
   * instead of a harness. Construct on `"sync"`, flip after composition.
   *
   * The flip belongs to the HARNESS ENTRY POINT that orchestrates a suite, not
   * to the suite: `openStoreForTestWithQueuedBridge` performs it once, after
   * the composition assertion. A test calling this itself is describing an
   * interleave, and that call is then part of the scenario rather than setup.
   *
   * Deliberately not a frame-kind predicate. Teaching this pair which frames
   * are "boot" and which are "body" would move domain knowledge into a
   * primitive whose whole value is being a dumb pipe.
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
  // MUTABLE for the constructor-composition reason documented on
  // `setDelivery`. Read at each delivery rather than captured, so a flip
  // applies to every frame after it and to none before.
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
          // A copy of the listener set: a listener that unsubscribes during
          // dispatch (the endpoint's own dispose does exactly this) must not
          // mutate the collection being walked.
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
      // Round-based rather than a single pass: a delivery enqueues more work
      // (a call answered inside a handler), and that work only appears after
      // the handler's promise has run. Each round drains what is there, then
      // waits for the frames those deliveries produce to be enqueued.
      //
      // That wait is a MACROTASK, and counting microtasks instead is what this
      // originally did - two `await Promise.resolve()` per round. It was enough
      // for the one-directional case and silently too shallow for a round trip:
      // a call answered by an async handler inside an async `serve`
      // needs about five ticks before its reply is posted, so the second round
      // found an empty queue, declared the pipe settled, and returned while the
      // reply was still two ticks away. The test that noticed did not report a
      // missing reply - it timed out, twenty seconds later, pointing at the
      // production call rather than at this line.
      //
      // A macrotask boundary is not a bigger guess. Every pending microtask
      // runs to completion before a `setTimeout` callback does, so any chain of
      // `await`s has finished by the time the next round looks - no depth to
      // tune, and no reply that settles just after the harness stopped looking.
      //
      // The one thing it assumes is REAL timers. No suite driving this harness
      // installs fake ones; one that did would hang here rather than pass with
      // a frame undelivered, which is the failure worth having.
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        const batch = queue.splice(0, queue.length);
        for (const deliver of batch) deliver();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        if (queue.length === 0) return;
      }
      // A bound, not a safety net: a pipe that never settles means the code
      // under test is posting in a loop, and a harness that spun forever would
      // report it as a timeout somewhere unrelated.
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
