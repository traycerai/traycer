import { describe, expect, it, vi } from "vitest";
import {
  createCommandQueue,
  COMMAND_AUTO_RETRY_WINDOW_MS,
  COMMAND_SELF_RETRY_MAX_DELAY_MS,
  type CommandRecord,
  type CommandResolution,
  type CommandSendFailure,
} from "../command-overlay";
import type { RuntimeEnvironment, RuntimeTimer } from "../runtime-environment";

type Intent = { readonly value: string };

/**
 * Scheduled callbacks the queue is waiting on, controllable by the test.
 *
 * The old fake dropped every `schedule` on the floor, which was invisible
 * until the queue gained a self-scheduled re-drive: a timer nothing can fire
 * makes the "never wakes" bug and the fix indistinguishable, so a pin written
 * against it would be green either way.
 */
type FakeTimers = {
  /** Delays requested, in order, including ones later cancelled. */
  readonly requested: number[];
  /** The `RuntimeScheduler.schedule` implementation this fake backs. */
  schedule(delayMs: number, callback: () => void): RuntimeTimer;
  /** Fires every timer that is still live. Returns how many ran. */
  fireAll(): number;
  /** Timers armed and not yet fired or cancelled. */
  liveCount(): number;
};

function makeFakeTimers(): FakeTimers {
  const requested: number[] = [];
  const live = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    requested,
    schedule: (delayMs, callback) => {
      requested.push(delayMs);
      const handle = ++nextHandle;
      live.set(handle, callback);
      return {
        cancel: () => {
          live.delete(handle);
        },
      };
    },
    fireAll: () => {
      const due = [...live.values()];
      live.clear();
      for (const callback of due) callback();
      return due.length;
    },
    liveCount: () => live.size,
  };
}

function makeEnvironment(
  now: () => number,
  timers: FakeTimers | null,
): RuntimeEnvironment {
  return {
    clock: { now },
    scheduler: {
      schedule: (delayMs, callback) =>
        timers === null
          ? { cancel: () => undefined }
          : timers.schedule(delayMs, callback),
      scheduleMicrotask: (callback) => callback(),
    },
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function makeQueue(options: {
  send: (command: CommandRecord<Intent>) => Promise<CommandResolution>;
  classifyFailure: ((error: unknown) => CommandSendFailure) | null;
  now: (() => number) | null;
  timers: FakeTimers | null;
  onEnqueued: ((command: CommandRecord<Intent>) => boolean) | null;
  onUnknownOutcome: ((command: CommandRecord<Intent>) => void) | null;
  onResolved: ((command: CommandRecord<Intent>) => void) | null;
}) {
  let nextId = 0;
  return createCommandQueue<Intent>({
    environment: makeEnvironment(options.now ?? (() => 123), options.timers),
    idFactory: { next: () => `command-${++nextId}` },
    send: options.send,
    classifyFailure:
      options.classifyFailure ??
      (() => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      })),
    accept: () => true,
    onEnqueued: options.onEnqueued ?? (() => true),
    onUnknownOutcome: options.onUnknownOutcome ?? (() => undefined),
    onResolved: options.onResolved ?? (() => undefined),
  });
}

const DEFAULT_QUEUE_OPTIONS = {
  classifyFailure: null,
  now: null,
  timers: null,
  onEnqueued: null,
  onUnknownOutcome: null,
  onResolved: null,
} as const;

function committed(hostId: string): CommandResolution {
  return { kind: "committed", hostId, entityVersion: 4 };
}

async function settleQueueMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createCommandQueue", () => {
  it("sends accepted commands FIFO, waiting for the first result before the next", async () => {
    const resolvers: Array<(resolution: CommandResolution) => void> = [];
    const sent: string[] = [];
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      send: (command) => {
        sent.push(command.commandId);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });

    const first = queue.enqueue({
      intent: { value: "first" },
      expectedEntityVersion: null,
    });
    const second = queue.enqueue({
      intent: { value: "second" },
      expectedEntityVersion: null,
    });
    if (first === null || second === null) throw new Error("expected commands");
    await settleQueueMicrotasks();

    expect(sent).toEqual([first.commandId]);
    expect(queue.list().map((command) => command.intent.value)).toEqual([
      "first",
      "second",
    ]);

    resolvers.shift()?.(committed("host-1"));
    await settleQueueMicrotasks();
    expect(sent).toEqual([first.commandId, second.commandId]);
  });

  it("keeps a queued transport failure blocked until retryPending", async () => {
    let attempts = 0;
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disconnected before dispatch");
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "disconnected before dispatch",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(attempts).toBe(1);
    expect(queue.list()[0]?.delivery).toBe("queued");
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.state).toBe("committed");
  });

  it("bounds retries after a keyed attempt, while pre-send failures remain retryable", async () => {
    let now = 123;
    let attempts = 0;
    const unknown = vi.fn();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      now: () => now,
      send: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transport unavailable");
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "transport unavailable",
        boundedRetry: true,
        retryAfterMs: null,
      }),
      onUnknownOutcome: unknown,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(attempts).toBe(1);
    expect(queue.list()[0]?.delivery).toBe("queued");

    now += COMMAND_AUTO_RETRY_WINDOW_MS - 1;
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.delivery).toBe("queued");

    now += COMMAND_AUTO_RETRY_WINDOW_MS;
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.delivery).toBe("unknown-outcome");
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: command.commandId,
        delivery: "unknown-outcome",
      }),
    );

    queue.retry(command.commandId);
    await settleQueueMicrotasks();
    expect(attempts).toBe(3);
    expect(queue.list()[0]?.state).toBe("committed");
    expect(queue.list()[0]?.delivery).toBe("settled");

    let preSendAttempts = 0;
    const preSendQueue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      now: () => now + COMMAND_AUTO_RETRY_WINDOW_MS * 2,
      send: async () => {
        preSendAttempts += 1;
        if (preSendAttempts === 1) throw new Error("offline");
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    });
    const preSend = preSendQueue.enqueue({
      intent: { value: "offline" },
      expectedEntityVersion: null,
    });
    if (preSend === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    preSendQueue.retryPending();
    await settleQueueMicrotasks();
    expect(preSendAttempts).toBe(2);
    expect(preSendQueue.list()[0]?.state).toBe("committed");
  });

  it("re-drives a queued failure that asked for a timer, and unblocks the writes stuck behind it", async () => {
    // The wedge: a `queued` command sits in `blockedUntilRetry`, and `pump`
    // refuses to look past the FIFO head - so the head blocks every later
    // write too. That is fine for a failure a reconnect is OWED for, because
    // `retryPending()` fires on the events that resolve those. It is not fine
    // for a refusal the transport ANSWERED over a stream that stays open
    // (`E_IDEMPOTENCY_CACHE_SATURATED`): no reconnect is owed, no snapshot
    // lands, and the command waits for the life of the session with no Retry
    // affordance on it or on anything behind it.
    const timers = makeFakeTimers();
    const sent: string[] = [];
    let attempts = 0;
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      timers,
      send: async (command) => {
        attempts += 1;
        if (attempts === 1) throw new Error("idempotency cache saturated");
        sent.push(command.intent.value);
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "idempotency cache saturated",
        boundedRetry: false,
        retryAfterMs: 2_000,
      }),
    });
    const head = queue.enqueue({
      intent: { value: "head" },
      expectedEntityVersion: null,
    });
    const behind = queue.enqueue({
      intent: { value: "behind" },
      expectedEntityVersion: null,
    });
    if (head === null || behind === null) {
      throw new Error("expected both commands");
    }
    await settleQueueMicrotasks();

    // Nothing has gone out beyond the refused attempt, and BOTH commands are
    // still pending - the second one purely because the first is in the way.
    expect(sent).toEqual([]);
    expect(queue.pending().map((record) => record.intent.value)).toEqual([
      "head",
      "behind",
    ]);
    // THE REDDENING ASSERTION. With no self-timer nothing is armed here, and
    // no external event is owed that would arm one.
    expect(timers.requested).toEqual([2_000]);

    expect(timers.fireAll()).toBe(1);
    await settleQueueMicrotasks();

    // Both drain, in order, off the queue's own timer - no reconnect, no
    // snapshot, no user gesture.
    expect(sent).toEqual(["head", "behind"]);
    expect(queue.pending()).toEqual([]);
    // Nothing left armed: a timer surviving its command would fire into a
    // disposed queue.
    expect(timers.liveCount()).toBe(0);
  });

  it("backs the re-drive off per attempt and clamps it, rather than re-asking a refusing host on a fixed tick", async () => {
    const timers = makeFakeTimers();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      timers,
      // Refuses forever: saturation that does not clear is the case a fixed
      // interval turns into a request loop.
      send: () => Promise.reject(new Error("idempotency cache saturated")),
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "idempotency cache saturated",
        boundedRetry: false,
        retryAfterMs: 8_000,
      }),
    });
    const command = queue.enqueue({
      intent: { value: "head" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    for (let round = 0; round < 4; round += 1) {
      timers.fireAll();
      await settleQueueMicrotasks();
    }

    // 8s, then doubling, then held at the ceiling - not five 8s ticks, and not
    // an unbounded climb either.
    expect(timers.requested).toEqual([
      8_000,
      16_000,
      COMMAND_SELF_RETRY_MAX_DELAY_MS,
      COMMAND_SELF_RETRY_MAX_DELAY_MS,
      COMMAND_SELF_RETRY_MAX_DELAY_MS,
    ]);
  });

  it("retires a BOUNDED failure that also self-times, on its own timer, instead of re-driving it past the replay window", async () => {
    // The combination this file had never seen. Until the write path's
    // exhausted unary dial, `boundedRetry` and `retryAfterMs` were disjoint:
    // every self-timing failure was `boundedRetry: false`, so the replay
    // deadline was only ever consulted where it was written, in `retryPending`.
    //
    // A failure that is BOTH walks its own timer, and a deadline enforced only
    // on the drain's path is no deadline at all for it: the command re-drives
    // itself every backoff for as long as the host keeps refusing, straight
    // past the dedupe retention its key depends on, and executes a second time
    // on a host that has forgotten the first. That is precisely the outcome
    // `COMMAND_AUTO_RETRY_WINDOW_MS` exists to prevent, arrived at by the one
    // route that was not checking it.
    //
    // Ablate `releaseQueuedCommand` back to a bare
    // `blockedUntilRetry.delete(commandId)` on the timer path and `attempts`
    // climbs past 2 while `delivery` stays `"queued"`.
    const timers = makeFakeTimers();
    let now = 123;
    let attempts = 0;
    const unknown = vi.fn();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      timers,
      now: () => now,
      // Refuses forever, which is what makes the window - rather than success -
      // the thing that has to stop it.
      send: () => {
        attempts += 1;
        return Promise.reject(new Error("dial failed"));
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "dial failed",
        boundedRetry: true,
        retryAfterMs: 2_000,
      }),
      onUnknownOutcome: unknown,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(attempts).toBe(1);

    // Inside the window: the timer re-drives, which is the whole point of
    // giving this failure one. Asserted so the pin cannot pass by disabling
    // the self-retry it is meant to bound.
    now += COMMAND_AUTO_RETRY_WINDOW_MS - 1;
    expect(timers.fireAll()).toBe(1);
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.delivery).toBe("queued");

    // Past it: the same timer must retire the command rather than send again.
    now += 2;
    expect(timers.fireAll()).toBe(1);
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.delivery).toBe("unknown-outcome");
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: command.commandId,
        delivery: "unknown-outcome",
      }),
    );
    // And it leaves nothing armed behind it, so the retired command cannot be
    // woken by a timer the retirement forgot to cancel.
    expect(timers.liveCount()).toBe(0);
  });

  it("a queued failure that asked for NO timer still waits for an external drain", async () => {
    // The control, and the reason the field is `number | null` rather than a
    // constant applied to every queued failure: a dead transport's recovery is
    // an event `retryPending()` already fires on, and a self-timer there would
    // only race it. This is the pre-existing contract, asserted so the new
    // path cannot quietly become the only path.
    const timers = makeFakeTimers();
    let attempts = 0;
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      timers,
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(timers.requested).toEqual([]);
    expect(attempts).toBe(1);

    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.state).toBe("committed");
  });

  it("does not auto-retry an unknown outcome; retry(commandId) is explicit", async () => {
    let attempts = 0;
    const unknown = vi.fn();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection dropped after send");
        return committed("host-1");
      },
      classifyFailure: (): CommandSendFailure => ({
        kind: "unknown-outcome",
        reason: "connection dropped after send",
      }),
      onUnknownOutcome: unknown,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(attempts).toBe(1);
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: command.commandId,
        delivery: "unknown-outcome",
      }),
    );
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(1);
    queue.retry(command.commandId);
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);
    expect(queue.list()[0]?.state).toBe("committed");
  });

  it("anchors the bounded retry deadline to the first keyed failure", async () => {
    let now = 0;
    let attempts = 0;
    const unknown = vi.fn();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      now: () => now,
      send: async () => {
        attempts += 1;
        throw new Error(`disconnect-${attempts}`);
      },
      classifyFailure: (): CommandSendFailure =>
        attempts < 3
          ? {
              kind: "queued",
              reason: "keyed transport failure",
              boundedRetry: true,
              retryAfterMs: null,
            }
          : {
              kind: "queued",
              reason: "pre-send transport failure",
              boundedRetry: false,
              retryAfterMs: null,
            },
      onUnknownOutcome: unknown,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    now = COMMAND_AUTO_RETRY_WINDOW_MS - 100;
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(2);

    // A later bounded failure must not slide the original deadline, and a
    // subsequent pure pre-send failure must not clear it.
    now = COMMAND_AUTO_RETRY_WINDOW_MS - 1;
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(3);
    expect(queue.list()[0]?.delivery).toBe("queued");

    now = COMMAND_AUTO_RETRY_WINDOW_MS;
    queue.retryPending();
    await settleQueueMicrotasks();
    expect(attempts).toBe(3);
    expect(queue.list()[0]?.delivery).toBe("unknown-outcome");
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: command.commandId }),
    );
  });

  it("retains a rejected intent as terminal and unacknowledged", async () => {
    const onResolved = vi.fn();
    const resolution: CommandResolution = {
      kind: "rejected",
      code: "PRECONDITION_FAILED",
      reason: "The artifact changed on the host",
      retryable: true,
    };
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      send: async () => resolution,
      onResolved,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: 3,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    const retained = queue.list()[0];
    expect(retained).toMatchObject({
      commandId: command.commandId,
      intent: { value: "rename" },
      state: "rejected",
      delivery: "settled",
      resolution,
    });
    expect(queue.pending()).toEqual([]);
    expect(queue.unacknowledged()).toEqual([retained]);
    expect(onResolved).toHaveBeenCalledTimes(1);

    queue.resolve(command.commandId, committed("host-1"));
    expect(queue.list()[0]?.state).toBe("rejected");
    expect(onResolved).toHaveBeenCalledTimes(1);
    queue.discard(command.commandId);
    expect(queue.list()).toEqual([]);
  });

  it("accepts committed to superseded, while other terminal transitions stay idempotent", async () => {
    const onResolved = vi.fn();
    const queue = makeQueue({
      ...DEFAULT_QUEUE_OPTIONS,
      send: async () => committed("host-1"),
      onResolved,
    });
    const command = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(queue.list()[0]?.state).toBe("committed");

    const superseded: CommandResolution = {
      kind: "superseded",
      observedAtMs: 456,
      via: "record-lane",
    };
    queue.resolve(command.commandId, superseded);
    expect(queue.list()[0]?.resolution).toEqual(superseded);
    expect(onResolved).toHaveBeenCalledTimes(2);

    queue.resolve(command.commandId, {
      kind: "rejected",
      code: "LATE",
      reason: "late",
      retryable: false,
    });
    queue.resolve(command.commandId, committed("host-2"));
    expect(queue.list()[0]?.state).toBe("superseded");
    expect(onResolved).toHaveBeenCalledTimes(2);
  });
});
