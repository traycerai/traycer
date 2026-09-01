import { describe, expect, it } from "vitest";
import {
  COMMAND_AUTO_RETRY_WINDOW_MS,
  createCommandQueue,
  type CommandRecord,
  type CommandResolution,
  type RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-error";
import {
  classifyEpicWriteCommandFailure,
  EpicWriteCommandTransportUnavailableError,
  type EpicWriteCommandIntent,
} from "../epic-write-command";

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

function rpcError(
  code: "E_IDEMPOTENCY_CACHE_SATURATED" | "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    { code, message: code },
    "request-1",
    "epic.updateTitle",
  );
}

async function settleQueueMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("classifyEpicWriteCommandFailure", () => {
  it("keeps persistent pre-dispatch saturation queued beyond the ambiguity deadline and preserves FIFO", async () => {
    let now = 100;
    let saturated = true;
    let nextCommandId = 0;
    const sentCommandIds: string[] = [];
    const unknownCommandIds: string[] = [];
    const queue = createCommandQueue<EpicWriteCommandIntent>({
      environment: makeEnvironment(() => now),
      idFactory: {
        next: () => {
          nextCommandId += 1;
          return `command-${nextCommandId}`;
        },
      },
      send: (
        command: CommandRecord<EpicWriteCommandIntent>,
      ): Promise<CommandResolution> => {
        sentCommandIds.push(command.commandId);
        if (saturated) {
          return Promise.reject(rpcError("E_IDEMPOTENCY_CACHE_SATURATED"));
        }
        return Promise.resolve({
          kind: "committed",
          hostId: "host-1",
          entityVersion: null,
        });
      },
      classifyFailure: classifyEpicWriteCommandFailure,
      accept: () => true,
      onEnqueued: () => true,
      onUnknownOutcome: (command) => {
        unknownCommandIds.push(command.commandId);
      },
      onResolved: () => undefined,
    });

    const first = queue.enqueue({
      intent: {
        kind: "update-epic-title",
        title: "First rename",
        updatedAt: 100,
      },
      expectedEntityVersion: null,
    });
    if (first === null) throw new Error("expected first command to enqueue");
    await settleQueueMicrotasks();

    const second = queue.enqueue({
      intent: {
        kind: "update-epic-title",
        title: "Second rename",
        updatedAt: 101,
      },
      expectedEntityVersion: null,
    });
    if (second === null) throw new Error("expected second command to enqueue");
    await settleQueueMicrotasks();

    expect(queue.list()).toMatchObject([
      {
        commandId: "command-1",
        state: "pending",
        delivery: "queued",
        attempts: 1,
      },
      {
        commandId: "command-2",
        state: "pending",
        delivery: "queued",
        attempts: 0,
      },
    ]);

    now = 100 + COMMAND_AUTO_RETRY_WINDOW_MS + 1;
    queue.retryPending();
    await settleQueueMicrotasks();

    expect(queue.list()).toMatchObject([
      {
        commandId: "command-1",
        state: "pending",
        delivery: "queued",
        attempts: 2,
      },
      {
        commandId: "command-2",
        state: "pending",
        delivery: "queued",
        attempts: 0,
      },
    ]);
    expect(unknownCommandIds).toEqual([]);

    saturated = false;
    queue.retryPending();
    await settleQueueMicrotasks();

    expect(queue.list()).toMatchObject([
      {
        commandId: "command-1",
        state: "committed",
        delivery: "settled",
        attempts: 3,
      },
      {
        commandId: "command-2",
        state: "committed",
        delivery: "settled",
        attempts: 1,
      },
    ]);
    expect(sentCommandIds).toEqual([
      "command-1",
      "command-1",
      "command-1",
      "command-2",
    ]);
  });

  it("classifies an over-ceiling replay as unknown-outcome", () => {
    expect(
      classifyEpicWriteCommandFailure(
        rpcError("E_IDEMPOTENCY_OUTCOME_UNKNOWN"),
      ),
    ).toEqual({
      kind: "unknown-outcome",
      reason: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
    });
  });

  it("asks for a self-timer when the DIAL ran out, and for none when a reconnect is owed", () => {
    // The three members of the `queued` transport branch, split by the only
    // question `retryAfterMs` asks: will anything ever wake this command.
    //
    // `send`'s first gate raises `EpicWriteCommandTransportUnavailableError` on
    // exactly the predicate `drainWritePathsAfterReconnect` gates on, and a
    // stale binding is a transport change that reaches the same drain - both
    // are owed an event, so a timer would only race it. A
    // `RetryableTransportError` can
    // only be raised on the far side of that gate, which is the proof that the
    // lane is up and NOTHING is owed: unaries dial their own socket per
    // attempt, so the dial ran out underneath streams that never moved. With
    // `pump` refusing to look past the FIFO head, a null here parks this
    // command and every later metadata write for the life of the session.
    //
    // Asserted as a triple rather than one case, because the defect is the
    // branch answering UNIFORMLY - which it did, and which a single-member pin
    // would have called correct.
    expect(
      classifyEpicWriteCommandFailure(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "dial failed",
          requestId: "request-1",
          method: "epic.updateTitle",
          fatalDetails: null,
        }),
      ),
    ).toEqual({
      kind: "queued",
      reason: "dial failed",
      boundedRetry: true,
      retryAfterMs: 2_000,
    });

    expect(
      classifyEpicWriteCommandFailure(
        new StaleHostBindingAuthorityError("host-1"),
      ),
    ).toMatchObject({
      kind: "queued",
      boundedRetry: false,
      retryAfterMs: null,
    });

    expect(
      classifyEpicWriteCommandFailure(
        new EpicWriteCommandTransportUnavailableError(),
      ),
    ).toMatchObject({
      kind: "queued",
      boundedRetry: false,
      retryAfterMs: null,
    });
  });
});
