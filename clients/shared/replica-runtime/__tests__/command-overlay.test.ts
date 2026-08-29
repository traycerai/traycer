import { describe, expect, it, vi } from "vitest";
import {
  createCommandQueue,
  COMMAND_AUTO_RETRY_WINDOW_MS,
  type CommandRecord,
  type CommandResolution,
  type CommandSendFailure,
} from "../command-overlay";
import type { RuntimeEnvironment } from "../runtime-environment";

type Intent = { readonly value: string };

function makeEnvironment(now: () => number): RuntimeEnvironment {
  return {
    clock: { now },
    scheduler: {
      schedule: () => ({ cancel: () => undefined }),
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
  onEnqueued: ((command: CommandRecord<Intent>) => boolean) | null;
  onUnknownOutcome: ((command: CommandRecord<Intent>) => void) | null;
  onResolved: ((command: CommandRecord<Intent>) => void) | null;
}) {
  let nextId = 0;
  return createCommandQueue<Intent>({
    environment: makeEnvironment(options.now ?? (() => 123)),
    idFactory: { next: () => `command-${++nextId}` },
    send: options.send,
    classifyFailure:
      options.classifyFailure ??
      (() => ({ kind: "queued", reason: "offline", boundedRetry: false })),
    accept: () => true,
    onEnqueued: options.onEnqueued ?? (() => true),
    onUnknownOutcome: options.onUnknownOutcome ?? (() => undefined),
    onResolved: options.onResolved ?? (() => undefined),
  });
}

const DEFAULT_QUEUE_OPTIONS = {
  classifyFailure: null,
  now: null,
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
            }
          : {
              kind: "queued",
              reason: "pre-send transport failure",
              boundedRetry: false,
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
