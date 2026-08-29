import { describe, expect, it } from "vitest";
import {
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

function makeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 100 },
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("classifyEpicWriteCommandFailure", () => {
  it("keeps a pre-dispatch saturation refusal queued and retries the same command key on the next drain", async () => {
    const sentCommandIds: string[] = [];
    let attempt = 0;
    const queue = createCommandQueue<EpicWriteCommandIntent>({
      environment: makeEnvironment(),
      idFactory: { next: () => "stable-command-key" },
      send: async (
        command: CommandRecord<EpicWriteCommandIntent>,
      ): Promise<CommandResolution> => {
        sentCommandIds.push(command.commandId);
        attempt += 1;
        if (attempt === 1) {
          throw rpcError("E_IDEMPOTENCY_CACHE_SATURATED");
        }
        return { kind: "committed", hostId: "host-1", entityVersion: null };
      },
      classifyFailure: classifyEpicWriteCommandFailure,
      accept: () => true,
      onEnqueued: () => true,
      onUnknownOutcome: () => undefined,
      onResolved: () => undefined,
    });

    const command = queue.enqueue({
      intent: {
        kind: "update-epic-title",
        title: "Renamed",
        updatedAt: 100,
      },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command to enqueue");
    await settleQueueMicrotasks();

    expect(queue.list()[0]).toMatchObject({
      commandId: "stable-command-key",
      state: "pending",
      delivery: "queued",
      attempts: 1,
    });

    queue.retryPending();
    await settleQueueMicrotasks();

    expect(queue.list()[0]).toMatchObject({
      commandId: "stable-command-key",
      state: "committed",
      delivery: "settled",
      attempts: 2,
    });
    expect(sentCommandIds).toEqual([
      "stable-command-key",
      "stable-command-key",
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
