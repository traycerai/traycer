import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
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
  type IHostMessenger,
  type RequiredHostMethodVersion,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRequestDispatchOptions,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-error";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { poolHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  isTargetAnswer,
  markTargetAnswer,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  createRetryingMessenger,
  finalRefusalOf,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  classifyEpicWriteCommandFailure,
  EpicWriteCommandTransportUnavailableError,
  type EpicWriteCommandIntent,
} from "../epic-write-command";
import { dispatchEpicWriteCommand } from "../epic-write-command-dispatch";

const POOL_ENTRY = poolHostDirectoryEntry("wss://pool.test/rpc");
if (POOL_ENTRY === null) throw new Error("pool fixture must build");

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

function requesterThatNeverSends(): HostRequester<typeof hostRpcRegistry> {
  const error = transportFailureBeforeSend({
    message: "The pool session closed before the request frame was sent.",
    requestId: "unsent-epic-title-write",
    method: "epic.updateTitle",
  });
  const rejectRequest = <Method extends keyof typeof hostRpcRegistry & string>(
    _method: Method,
    _params: RequestOfMethod<typeof hostRpcRegistry, Method>,
  ): Promise<ResponseOfMethod<typeof hostRpcRegistry, Method>> =>
    Promise.reject(error);
  const rejectRequestWithFloor = <
    Method extends keyof typeof hostRpcRegistry & string,
  >(
    method: Method,
    params: RequestOfMethod<typeof hostRpcRegistry, Method>,
    _signal: AbortSignal | undefined,
    _requiredHostMethodVersion: RequiredHostMethodVersion,
  ): Promise<ResponseOfMethod<typeof hostRpcRegistry, Method>> =>
    rejectRequest(method, params);
  const rejectRequestWithOptions = <
    Method extends keyof typeof hostRpcRegistry & string,
  >(
    method: Method,
    params: RequestOfMethod<typeof hostRpcRegistry, Method>,
    _options: HostRequestDispatchOptions,
  ): Promise<ResponseOfMethod<typeof hostRpcRegistry, Method>> =>
    rejectRequest(method, params);

  return {
    getRegistry: () => hostRpcRegistry,
    getActiveHost: () => null,
    getActiveHostId: () => POOL_HOST_ID,
    getRequestContext: () => null,
    getRequestContextUserId: () => null,
    onChange: () => () => undefined,
    request: rejectRequest,
    requestWithIdempotencyKey: rejectRequest,
    requestWithOptions: rejectRequestWithOptions,
    requestWithSignal: rejectRequest,
    requestWithSignalRequiringHostMethodVersion: rejectRequestWithFloor,
    requestWithResponseTimeout: rejectRequest,
  };
}

function openPoolRequester(messenger: IHostMessenger<typeof hostRpcRegistry>) {
  const queryClient = new QueryClient();
  const spine = new HostClient<typeof hostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === POOL_HOST_ID ? POOL_ENTRY : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "pool-write-test-token",
    }),
  );
  return {
    queryClient,
    spine,
    requester: spine.createRequesterForHostId(POOL_HOST_ID),
  };
}

describe("classifyEpicWriteCommandFailure", () => {
  it("keeps a queued title unknown after the exact received pool wire answer", async () => {
    const messenger = new MockHostMessenger<typeof hostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "wire-unknown-title-request",
      handlers: {
        "epic.updateTitle": () => {
          const error = HostRpcError.fromWireEnvelope(
            {
              code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
              message:
                "The authoritative write outcome could not be confirmed.",
            },
            "wire-unknown-title-request",
            "epic.updateTitle",
          );
          markTargetAnswer(error);
          throw error;
        },
      },
    });
    const { queryClient, spine, requester } = openPoolRequester(messenger);
    const unknownCommandIds: string[] = [];
    let nextCommandId = 0;
    const queue = createCommandQueue<EpicWriteCommandIntent>({
      environment: makeEnvironment(() => 100),
      idFactory: {
        next: () => {
          nextCommandId += 1;
          return `wire-command-${String(nextCommandId)}`;
        },
      },
      send: async (command) => {
        const result = await dispatchEpicWriteCommand(
          { epicId: "epic-pool-wire-unknown", requester: () => requester },
          command.commandId,
          command.intent,
        );
        return {
          kind: "committed",
          hostId: result.hostId,
          entityVersion: null,
        };
      },
      classifyFailure: classifyEpicWriteCommandFailure,
      accept: () => true,
      onEnqueued: () => true,
      onUnknownOutcome: (command) => {
        unknownCommandIds.push(command.commandId);
      },
      onResolved: () => undefined,
    });

    try {
      const command = queue.enqueue({
        intent: {
          kind: "update-epic-title",
          title: "Pool title target",
          updatedAt: 100,
        },
        expectedEntityVersion: null,
      });
      if (command === null)
        throw new Error("expected title command to enqueue");
      await settleQueueMicrotasks();

      expect(messenger.calls).toHaveLength(1);
      expect(messenger.calls[0]?.method).toBe("epic.updateTitle");
      expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(POOL_HOST_ID);
      expect(messenger.calls[0]?.idempotencyKey).toBe(command.commandId);
      expect(queue.list()).toMatchObject([
        {
          commandId: command.commandId,
          state: "pending",
          delivery: "unknown-outcome",
          attempts: 1,
        },
      ]);
      expect(unknownCommandIds).toEqual([command.commandId]);
    } finally {
      queue.dispose();
      spine.dispose();
      queryClient.clear();
    }
  });

  it("keeps an unfamiliar ordinary pool error as a marked generic answer on a real title request", async () => {
    const decodedErrors: HostRpcError[] = [];
    const messenger = new MockHostMessenger<typeof hostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "legacy-pool-title-request",
      handlers: {
        "epic.updateTitle": () => {
          const error = HostRpcError.fromWireEnvelope(
            {
              code: "E_LEGACY_WORKER_BUSY",
              message: "The pool could not run this write.",
            },
            "legacy-pool-title-request",
            "epic.updateTitle",
          );
          markTargetAnswer(error);
          decodedErrors.push(error);
          throw error;
        },
      },
    });
    const { queryClient, spine, requester } = openPoolRequester(messenger);

    try {
      const failure = await dispatchEpicWriteCommand(
        {
          epicId: "epic-pool-legacy-error",
          requester: () => requester,
        },
        "legacy-pool-command",
        { kind: "update-epic-title", title: "target-a", updatedAt: 100 },
      ).then(
        () => null,
        (error: unknown) => classifyEpicWriteCommandFailure(error),
      );

      expect(failure).toMatchObject({ kind: "unknown-outcome" });
      const decodedError = decodedErrors[0];
      expect(decodedError.code).toBe("RPC_ERROR");
      expect(isTargetAnswer(decodedError)).toBe(true);
      expect(hostWriteFailureOutcome(decodedError, POOL_HOST_ID)).toBe(
        "unknown",
      );
      expect(messenger.calls).toHaveLength(1);
      expect(messenger.calls[0]).toMatchObject({
        method: "epic.updateTitle",
        idempotencyKey: "legacy-pool-command",
        authority: { endpoint: { hostId: POOL_HOST_ID } },
      });
    } finally {
      spine.dispose();
      queryClient.clear();
    }
  });

  it("keeps a prior keyed send unknown when the retry receives E_WRITE_NOT_STARTED", async () => {
    let requestCount = 0;
    const finalAnswers: HostRpcError[] = [];
    const retryEpisodeErrors: unknown[] = [];
    const baseMessenger = new MockHostMessenger<typeof hostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `retry-title-request-${String(requestCount + 1)}`,
      handlers: {
        "epic.updateTitle": () => {
          requestCount += 1;
          if (requestCount === 1) {
            throw new RetryableTransportError({
              replaySafetyFromKey: true,
              code: "RPC_ERROR",
              message: "The first response was lost.",
              requestId: "first-title-attempt",
              method: "epic.updateTitle",
              fatalDetails: null,
            });
          }
          const error = HostRpcError.fromWireEnvelope(
            {
              code: "E_WRITE_NOT_STARTED",
              message: "The retry's authoritative write did not start.",
            },
            "retry-title-request-2",
            "epic.updateTitle",
          );
          markTargetAnswer(error);
          finalAnswers.push(error);
          throw error;
        },
      },
    });
    const requesterRig = openPoolRequester(
      createRetryingMessenger(baseMessenger, {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleep: () => Promise.resolve(),
        random: () => 0,
      }),
    );

    try {
      const replyOutcome = await requesterRig.requester
        .requestWithIdempotencyKey(
          "epic.updateTitle",
          {
            epicDelta: {
              id: "epic-pool-retry-episode",
              title: "target-b",
              updatedAt: 200,
            },
          },
          "retry-episode-command",
        )
        .then(
          () => "success" as const,
          (error: unknown) => {
            retryEpisodeErrors.push(error);
            if (!(error instanceof HostRpcError)) {
              throw new Error("the retry reply was not a host RPC error");
            }
            return hostWriteFailureOutcome(error, POOL_HOST_ID);
          },
        );
      const finalAnswer = finalAnswers[0];
      const retryEpisodeError = retryEpisodeErrors[0];
      if (retryEpisodeError === undefined) {
        throw new Error("the retry episode did not return an error");
      }
      const failure = classifyEpicWriteCommandFailure(retryEpisodeError);
      const preservedRefusal = finalRefusalOf(retryEpisodeError);

      expect(replyOutcome).toBe("unknown");
      expect(failure).toMatchObject({ kind: "unknown-outcome" });
      expect(requestCount).toBe(2);
      expect(baseMessenger.calls.map((call) => call.idempotencyKey)).toEqual([
        "retry-episode-command",
        "retry-episode-command",
      ]);
      expect(finalAnswer.code).toBe("E_WRITE_NOT_STARTED");
      expect(isTargetAnswer(finalAnswer)).toBe(true);
      expect(hostWriteFailureOutcome(finalAnswer, POOL_HOST_ID)).toBe(
        "refused",
      );
      expect(retryEpisodeError).toBeInstanceOf(HostRpcError);
      expect(preservedRefusal).toBeInstanceOf(HostRpcError);
      expect(
        hostWriteFailureOutcome(
          retryEpisodeError instanceof HostRpcError
            ? retryEpisodeError
            : finalAnswer,
          POOL_HOST_ID,
        ),
      ).toBe("unknown");
      expect(
        preservedRefusal instanceof HostRpcError ? preservedRefusal.code : null,
      ).toBe("E_WRITE_NOT_STARTED");
    } finally {
      requesterRig.spine.dispose();
      requesterRig.queryClient.clear();
    }
  });

  it("leaves a pool write queued when dispatch proves it was not sent", async () => {
    const unknownCommandIds: string[] = [];
    let nextCommandId = 0;
    let attempts = 0;
    const queue = createCommandQueue<EpicWriteCommandIntent>({
      environment: makeEnvironment(() => 100),
      idFactory: {
        next: () => {
          nextCommandId += 1;
          return `command-${nextCommandId}`;
        },
      },
      send: async (command) => {
        attempts += 1;
        const result = await dispatchEpicWriteCommand(
          {
            epicId: "epic-pool-queue-not-sent",
            requester: requesterThatNeverSends,
          },
          command.commandId,
          command.intent,
        );
        return {
          kind: "committed",
          hostId: result.hostId,
          entityVersion: null,
        };
      },
      classifyFailure: classifyEpicWriteCommandFailure,
      accept: () => true,
      onEnqueued: () => true,
      onUnknownOutcome: (command) => {
        unknownCommandIds.push(command.commandId);
      },
      onResolved: () => undefined,
    });

    const command = queue.enqueue({
      intent: {
        kind: "update-epic-title",
        title: "Pending title",
        updatedAt: 100,
      },
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command to enqueue");
    await settleQueueMicrotasks();

    expect(attempts).toBe(1);
    expect(queue.list()).toMatchObject([
      {
        commandId: command.commandId,
        state: "pending",
        delivery: "queued",
        attempts: 1,
      },
    ]);
    expect(unknownCommandIds).toEqual([]);
  });

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
          replaySafetyFromKey: false,
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
