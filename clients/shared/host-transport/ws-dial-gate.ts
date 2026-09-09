import type { DialPriority } from "./dial-priority";

/**
 * A process-wide bound on how many host WebSockets may be CONNECTING at once,
 * with the Epic's own lanes let through ahead of boot prefetch.
 *
 * ## Why this exists
 *
 * Chromium's network service keeps ONE WebSocket throttler per RENDERER
 * PROCESS (`services/network/websocket_throttler.cc`) and delays every new
 * connection by
 *
 *     rand(1000..5000) ms * 2^min(pending + failed/(succeeded + 1), 16) / 65536
 *
 * where `pending` counts handshakes that have not completed. Under ~8 pending
 * that is tens of milliseconds; at 14-16 it is the full 1-5 seconds, PER new
 * socket. This app dials one socket per unary call and one per subscription,
 * so renderer boot hands the throttler ~50 simultaneous handshakes - and the
 * active Epic's lanes, created 45 ms after the shell mounted, completed 4.3
 * SECONDS later. Measured: list at 5823 ms, and 2051 ms with a gate of 6.
 *
 * The gate does not make connections cheaper. It stops the client asking for
 * more of them at once than the platform will serve promptly.
 *
 * ## Two queues, not one - and a reserve
 *
 * A FIFO gate still leaves the lanes behind the boot flood (measured: 720 ms
 * after session-ready). `interactive` drains fully before `background`, so a
 * lane dialed after twenty catalog prefetches takes the next free slot rather
 * than the twenty-first. `dial-priority.ts` owns which method is which.
 *
 * Ordering alone was still not enough, and the re-measure said why: it decides
 * ADMISSION, and a slot already granted is held for its whole handshake. Both
 * Epic lanes arrived to find all six slots held by prefetch and waited for the
 * next release (551-655 ms of the rows' wait after session-ready). So
 * background may hold at most {@link MAX_BACKGROUND_CONNECTING} of the slots -
 * capacity an interactive dial can count on finding free, rather than a place
 * in a queue it still has to wait out.
 *
 * ## What holds a slot, and what gives it back
 *
 * A slot is taken when the native socket is CONSTRUCTED and given back on the
 * first of `open` / `error` / `close` - the three events that mean the
 * handshake is no longer pending, which is exactly what the throttler counts.
 *
 * A socket the caller closes BEFORE its dial started is dequeued instead:
 * Chromium never sees it. That matters beyond saving a connection, because
 * "destroying a PendingConnection whose OnCompleteHandshake has not been
 * called represents a handshake failure" - every socket torn down mid-dial
 * raises the `failed` term above and slows down everyone else's dial. The
 * caller is still owed the `close` it asked for; the factories deliver it on a
 * microtask.
 *
 * Note what is NOT a release: the wrapper's own `close()`. A socket whose
 * handshake has started is still pending as far as the throttler is concerned,
 * whether or not this client has lost interest in it, so releasing there would
 * let the gate admit more concurrent handshakes than the cap names during
 * exactly the mid-dial teardown churn the cap exists for. The cost is that a
 * host black-holing its TCP connect can hold a slot until the platform's own
 * handshake timeout; that is bounded, it applies to an app that is already not
 * working, and both transports close such sockets on a 10 s dial timeout.
 *
 * One consequence to know before it is read as host evidence: because a native
 * constructor that throws is reported as `error` then `close` (the factories
 * have no caller frame left to throw into once construction is deferred),
 * `openSession` sees `erroredBeforeOpen` and classifies a MALFORMED URL as a
 * dial `refusal`, where before the gate `create()` threw out of the request and
 * reported no dial outcome at all. It is unreachable in practice - dial URLs
 * are built from host addresses, not user input - and reporting a bare close
 * instead would classify identically, so it stands as written.
 *
 * ## Runtime neutrality
 *
 * `@traycer-clients/shared` transport code is the CLI's too. Bun has no
 * throttle, so the gate buys nothing there - but it costs nothing either
 * (`queueMicrotask` is standard, the cap simply bounds concurrency), and a
 * second code path that only the renderer takes would be the more expensive
 * thing to own.
 */

/**
 * The cap. The throttler's knee is ~10 pending across the WHOLE renderer, and
 * this gate does not see every socket the renderer opens (Vite's HMR channel
 * in dev, DevTools), so it sits well under that rather than at it. Measured at
 * 6: ~70 ms per completed handshake with six in flight, i.e. the flood of ~50
 * drains in ~600 ms, against a 10 s dial timeout.
 *
 * It does see every HOST socket, including the relay leg - `RelaySocket` dials
 * through the same stream factory. The one way that could stop being true is a
 * Web Worker: a worker gets its own module instance and therefore its own
 * gate, while Chromium keeps counting both against one process. Today that
 * cannot happen by accident - the Epic worker proxies its stream frames
 * through the main thread, and `single-flight-imports-lint.test.ts` ("the
 * worker never dials") fails the build if anything under the worker directory
 * imports a socket factory. A worker that genuinely needed to dial would have
 * to be routed back through this thread, not given a second gate.
 */
const MAX_CONNECTING = 6;

/**
 * How many of those slots `background` may hold at once.
 *
 * Draining `interactive` first decides ADMISSION ORDER, and that turned out not
 * to be enough. A slot, once granted, is held for the whole handshake - so at
 * both Epic lane arrivals in the measured boot flood all six slots were already
 * held by `agent.gui.listModels` handshakes, and each lane waited for the next
 * RELEASE rather than jumping a queue. Under host load those handshakes ran
 * 100-245 ms (against ~70 ms idle), which is most of the 551-655 ms the rows
 * spent waiting after session-ready.
 *
 * Priority cannot preempt a granted slot - a handshake in flight is pending to
 * the throttler whether or not this client still wants it (see the release
 * rules above), so cancelling one would cost more than it saves. Reserving
 * capacity is the version of the same intent that works: an interactive dial
 * arriving at any moment finds at least `MAX_CONNECTING - MAX_BACKGROUND_CONNECTING`
 * slots that no prefetch can be holding.
 *
 * Three of six. The reserve has to be big enough for the burst that actually
 * matters - a task open dials its two Epic lanes plus a body lane, and the
 * shell's own calls arrive alongside them - while leaving enough for prefetch
 * that the boot flood still drains inside the same window. Interactive is NOT
 * capped: with nothing else queued it uses all six, so a run with no prefetch in
 * flight is unchanged.
 */
const MAX_BACKGROUND_CONNECTING = 3;

/** Strictly ordered: every `interactive` dial precedes every `background` one. */
const DRAIN_ORDER: readonly DialPriority[] = ["interactive", "background"];

export interface DialTicket {
  /**
   * Gives up a dial that has not started yet. `true` when this call dequeued
   * it - the caller now owes its own close notification, because no native
   * socket exists to deliver one. `false` when the dial has already started
   * (or was already cancelled), in which case the native socket is the
   * authority and `release` is what this ticket still owes.
   */
  cancel(): boolean;
  /** The handshake is no longer pending. Idempotent. */
  release(): void;
}

export interface DialGateStats {
  readonly connecting: number;
  /**
   * The same total, split by priority. Reported because the interesting
   * question about this gate is no longer "is it full" but "is it full of
   * prefetch" - `connectingBackground` at its cap with `queued` non-zero is the
   * reserve doing its job, and the same reading with `connectingInteractive` at
   * zero for a whole boot would mean the table has drifted.
   */
  readonly connectingInteractive: number;
  readonly connectingBackground: number;
  readonly queued: number;
}

export interface DialGate {
  /**
   * Registers a dial. `start` runs - once, never re-entrantly, always on a
   * later microtask - when a slot is free and this entry is at the head of the
   * highest-priority non-empty queue.
   */
  acquire(priority: DialPriority, start: () => void): DialTicket;
  stats(): DialGateStats;
}

interface QueueEntry {
  readonly priority: DialPriority;
  readonly start: () => void;
  started: boolean;
  cancelled: boolean;
  released: boolean;
}

/**
 * Builds an independent gate. Production shares exactly one
 * ({@link hostDialGate}) because the resource being rationed - concurrent
 * handshakes in this renderer process - is itself process-wide; this factory
 * exists so tests can exercise the queueing rules without module state
 * leaking between cases.
 */
export function createDialGate(): DialGate {
  const queues: Record<DialPriority, QueueEntry[]> = {
    interactive: [],
    background: [],
  };
  /**
   * The one place a slot is counted. The TOTAL is derived from these rather
   * than tracked beside them: two counters that must agree is a state the
   * release paths (normal, cancelled-mid-pump, `start` threw) could drift
   * apart, and the cap is not worth that risk.
   */
  const connectingByPriority: Record<DialPriority, number> = {
    interactive: 0,
    background: 0,
  };
  const totalConnecting = (): number =>
    connectingByPriority.interactive + connectingByPriority.background;
  /**
   * Re-entrancy guard. A `start` that fails synchronously releases its own
   * slot, which re-enters `pump` from inside `pump`'s own loop. The loop
   * re-reads the counts on every iteration and so already handles the freed
   * slot; letting the inner call proceed would instead recurse once per queued
   * entry.
   */
  let pumping = false;

  /**
   * Interactive is bounded only by the total; background additionally by its
   * own reserve. Asked BEFORE the queue is drained, so a background entry that
   * cannot be admitted stays queued in order rather than being shifted off and
   * pushed back.
   */
  function canAdmit(priority: DialPriority): boolean {
    if (priority === "interactive") return true;
    return connectingByPriority.background < MAX_BACKGROUND_CONNECTING;
  }

  function takeNext(): QueueEntry | null {
    for (const priority of DRAIN_ORDER) {
      if (!canAdmit(priority)) continue;
      const queue = queues[priority];
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry === undefined) break;
        if (entry.cancelled) continue;
        return entry;
      }
    }
    return null;
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (totalConnecting() < MAX_CONNECTING) {
        // `null` here means "nothing admissible", which is not the same as
        // "nothing queued": background at its reserve with free total capacity
        // stops the loop and waits for a RELEASE to re-enter it. Every release
        // pumps, so there is no path that leaves an admissible entry parked.
        const entry = takeNext();
        if (entry === null) return;
        entry.started = true;
        connectingByPriority[entry.priority] += 1;
        try {
          entry.start();
        } catch (cause) {
          // A `start` that threw never installed the listeners that release
          // this slot. Account for it here or the gate shrinks by one for the
          // life of the process - and after six, all host traffic stops. Both
          // factories translate a construction failure into `error` + `close`
          // themselves, so this is a backstop, not a live path.
          entry.released = true;
          connectingByPriority[entry.priority] -= 1;
          throw cause;
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    acquire(priority: DialPriority, start: () => void): DialTicket {
      const entry: QueueEntry = {
        priority,
        start,
        started: false,
        cancelled: false,
        released: false,
      };
      queues[priority].push(entry);
      // Deferred so `start` can never run inside the caller's constructor,
      // before the caller has finished wiring up the ticket it is about to
      // release.
      queueMicrotask(pump);
      return {
        cancel(): boolean {
          if (entry.started || entry.cancelled) return false;
          // Left in place for `takeNext` to skip. Splicing it out would be an
          // O(n) scan on every cancel, and the flood this gate exists for is
          // exactly when cancels come in bulk.
          entry.cancelled = true;
          return true;
        },
        release(): void {
          if (!entry.started || entry.released) return;
          entry.released = true;
          connectingByPriority[entry.priority] -= 1;
          pump();
        },
      };
    },

    stats(): DialGateStats {
      // Counts what is still WAITING, so a cancelled entry that no pump has
      // swept past yet does not read as a pending dial. Diagnostic only - a
      // linear scan is fine here and nothing on the dial path calls it.
      const waiting = (queue: readonly QueueEntry[]): number =>
        queue.filter((entry) => !entry.cancelled).length;
      return {
        connecting: totalConnecting(),
        connectingInteractive: connectingByPriority.interactive,
        connectingBackground: connectingByPriority.background,
        queued: waiting(queues.interactive) + waiting(queues.background),
      };
    },
  };
}

/**
 * The gate every host socket in this process passes through. Shared by the
 * unary and stream factories because they contend for the same platform
 * resource; a per-factory gate would let each open six.
 */
export const hostDialGate: DialGate = createDialGate();
