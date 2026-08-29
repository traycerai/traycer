import { describe, expect, it } from "vitest";
import {
  COMMAND_AUTO_RETRY_WINDOW_MS,
  createCommandQueue,
  type CommandRecord,
  type CommandResolution,
  type RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  classifyEpicWriteCommandFailure,
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
      send: async (
        command: CommandRecord<EpicWriteCommandIntent>,
      ): Promise<CommandResolution> => {
        sentCommandIds.push(command.commandId);
        if (saturated) {
          throw rpcError("E_IDEMPOTENCY_CACHE_SATURATED");
        }
        return { kind: "committed", hostId: "host-1", entityVersion: null };
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
});
