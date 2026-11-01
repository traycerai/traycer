import { describe, expect, it } from "vitest";
import type {
  ChatActiveTurn,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  resolveTurnPresentation,
  sendPlacement,
  type PendingTurn,
} from "@/stores/chats/chat-send-state";
import { resolvedTurnStatus } from "@/stores/chats/chat-run-activity";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const IDLE_QUEUE: ChatQueueState = { status: "idle", items: [] };

function queueWithOneItem(): ChatQueueState {
  return {
    status: "running",
    items: [
      {
        kind: "prompt",
        queueItemId: "queue-1",
        messageId: "message-queued",
        message: {
          kind: "user",
          content: { type: "doc", content: [] },
          browserAnnotations: [],
        },
        sender: { type: "user", userId: "user-1" },
        settings: SETTINGS,
        accountContext: { type: "PERSONAL" },
        sentFromHostId: null,
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

function activeTurn(overrides: Partial<ChatActiveTurn>): ChatActiveTurn {
  return {
    turnId: "turn-1",
    status: "running",
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 5_000,
    updatedAt: 5_000,
    sameTurnSteeringSupported: false,
    ...overrides,
  };
}

const PENDING: PendingTurn = {
  messageId: "message-1",
  sentAt: 1_000,
  settings: SETTINGS,
};

describe("sendPlacement on a host that publishes sendWouldQueue", () => {
  it("queues exactly when the host says the send would queue, whatever the local state reads", () => {
    expect(
      sendPlacement({
        activeTurn: null,
        turnInProgress: false,
        queue: IDLE_QUEUE,
        sendWouldQueue: true,
      }),
    ).toBe("queue");
    expect(
      sendPlacement({
        activeTurn: activeTurn({}),
        turnInProgress: true,
        queue: queueWithOneItem(),
        sendWouldQueue: false,
      }),
    ).toBe("transcript");
  });
});

describe("sendPlacement on an older host (sendWouldQueue absent)", () => {
  it("places in the transcript when nothing is running, queued or activating", () => {
    expect(
      sendPlacement({
        activeTurn: null,
        turnInProgress: false,
        queue: IDLE_QUEUE,
        sendWouldQueue: undefined,
      }),
    ).toBe("transcript");
  });

  it("queues behind an active turn", () => {
    expect(
      sendPlacement({
        activeTurn: activeTurn({}),
        turnInProgress: undefined,
        queue: IDLE_QUEUE,
        sendWouldQueue: undefined,
      }),
    ).toBe("queue");
  });

  it("queues while a turn is activating or stopping with no activeTurn", () => {
    expect(
      sendPlacement({
        activeTurn: null,
        turnInProgress: true,
        queue: IDLE_QUEUE,
        sendWouldQueue: undefined,
      }),
    ).toBe("queue");
  });

  it("queues behind queue items", () => {
    expect(
      sendPlacement({
        activeTurn: null,
        turnInProgress: false,
        queue: queueWithOneItem(),
        sendWouldQueue: undefined,
      }),
    ).toBe("queue");
  });

  it("never reads runStatus: a chat that is busy without a turn still takes the transcript", () => {
    // Running shells, detached subagents and wakes all make the host report
    // `running`; the placement must not follow it.
    const busyWithoutATurn = {
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      queue: IDLE_QUEUE,
      sendWouldQueue: undefined,
    };
    expect(sendPlacement(busyWithoutATurn)).toBe("transcript");
  });
});

describe("resolvedTurnStatus with a local pendingTurn", () => {
  it("shows Stop from Enter when the host has not yet said anything", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: IDLE_QUEUE,
          backgroundItems: [],
          turnInProgress: false,
          pendingTurn: PENDING,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("shows no Stop without a pendingTurn in the same state", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: IDLE_QUEUE,
          backgroundItems: [],
          turnInProgress: false,
          pendingTurn: null,
        },
        "running",
      ),
    ).toBeNull();
  });
});

describe("resolvedTurnStatus across a held Stop and a queue drain", () => {
  const between = {
    activeTurn: null,
    backgroundItems: [],
    turnInProgress: false,
    pendingTurn: null,
  };

  it("reads a held Stop as stopping until it is dispatched, even with no turn yet", () => {
    expect(
      resolvedTurnStatus(
        {
          ...between,
          queue: IDLE_QUEUE,
          pendingTurn: PENDING,
          heldStop: { messageId: "message-1", clientActionId: "action-1" },
        },
        null,
      ),
    ).toBe("stopping");
  });

  it("keeps Stop across a drain boundary once the latch says a host turn ended with a runnable backlog", () => {
    expect(
      resolvedTurnStatus(
        { ...between, queue: queueWithOneItem(), queueTurnContinuity: true },
        "running",
      ),
    ).toBe("running");
    expect(
      resolvedTurnStatus(
        { ...between, queue: queueWithOneItem(), queueTurnContinuity: true },
        null,
      ),
    ).toBe("running");
  });

  it("on a host that publishes no turn bit, queue items alone are no turn: no Stop", () => {
    expect(
      resolvedTurnStatus(
        { ...between, turnInProgress: undefined, queue: queueWithOneItem() },
        "running",
      ),
    ).toBeNull();
  });

  it("never shows Stop for a dock row alone: queue items without the latch read as no turn", () => {
    expect(
      resolvedTurnStatus(
        { ...between, queue: queueWithOneItem(), queueTurnContinuity: false },
        "running",
      ),
    ).toBeNull();
    expect(
      resolvedTurnStatus(
        {
          ...between,
          queue: queueWithOneItem(),
          queueTurnContinuity: undefined,
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("resolveTurnPresentation", () => {
  const base = {
    chatId: "chat-1",
    observedAt: 0,
    localMessageCreatedAt: null,
    hostAnchorAt: null,
  };

  it("draws a local send from its own settings, timer origin and message id before any host frame", () => {
    const presentation = resolveTurnPresentation({
      ...base,
      pendingTurn: PENDING,
      activeTurn: null,
    });

    expect(presentation.settings).toEqual(SETTINGS);
    expect(presentation.elapsedStartedAt).toBe(1_000);
    expect(presentation.verbSeed).toBe("chat-1:message-1");
  });

  it("times a send that waited in the dock from the drain instant, before and after activeTurn arrives", () => {
    const drained: PendingTurn = { ...PENDING, timerOrigin: 90_000 };
    const before = resolveTurnPresentation({
      ...base,
      pendingTurn: drained,
      activeTurn: null,
    });
    const after = resolveTurnPresentation({
      ...base,
      pendingTurn: drained,
      activeTurn: activeTurn({ userMessageId: "message-1", startedAt: 90_040 }),
    });

    expect(before.elapsedStartedAt).toBe(90_000);
    expect(after.elapsedStartedAt).toBe(90_000);
  });

  it("keeps the timer origin and verb seed when activeTurn arrives naming the send", () => {
    const before = resolveTurnPresentation({
      ...base,
      pendingTurn: PENDING,
      activeTurn: null,
    });
    const after = resolveTurnPresentation({
      ...base,
      pendingTurn: PENDING,
      activeTurn: activeTurn({ userMessageId: "message-1", startedAt: 5_000 }),
    });

    expect(after.elapsedStartedAt).toBe(before.elapsedStartedAt);
    expect(after.verbSeed).toBe(before.verbSeed);
  });

  it("takes the host's icon and model once activeTurn names the send, and falls back to the send's settings before", () => {
    const routed = resolveTurnPresentation({
      ...base,
      pendingTurn: PENDING,
      activeTurn: activeTurn({ harnessId: "codex", model: "gpt-5-codex" }),
    });

    expect(routed.settings?.harnessId).toBe("codex");
    expect(routed.settings?.model).toBe("gpt-5-codex");
  });

  it("times a turn that is not this send's from the host's start, never from the pending send", () => {
    const presentation = resolveTurnPresentation({
      ...base,
      pendingTurn: PENDING,
      activeTurn: activeTurn({
        userMessageId: "someone-elses-message",
        startedAt: 7_000,
      }),
    });

    expect(presentation.elapsedStartedAt).toBe(7_000);
    expect(presentation.verbSeed).toBe("chat-1:someone-elses-message");
  });

  it("falls back to the instant the client first saw the turn when nothing else dates it", () => {
    const presentation = resolveTurnPresentation({
      ...base,
      observedAt: 9_000,
      pendingTurn: null,
      activeTurn: null,
    });

    expect(presentation.elapsedStartedAt).toBe(9_000);
  });

  it("seeds an autonomous turn's verb from its turn id", () => {
    const presentation = resolveTurnPresentation({
      ...base,
      pendingTurn: null,
      activeTurn: activeTurn({ userMessageId: null, turnId: "turn-auto" }),
    });

    expect(presentation.verbSeed).toBe("chat-1:turn-auto");
  });

  it("anchors the row at max(host time, local copy + 1) while the local copy is on screen", () => {
    expect(
      resolveTurnPresentation({
        ...base,
        pendingTurn: PENDING,
        activeTurn: null,
        localMessageCreatedAt: 2_000,
        hostAnchorAt: 1_500,
      }).rowAnchorAt,
    ).toBe(2_001);
    expect(
      resolveTurnPresentation({
        ...base,
        pendingTurn: PENDING,
        activeTurn: null,
        localMessageCreatedAt: 2_000,
        hostAnchorAt: 3_000,
      }).rowAnchorAt,
    ).toBe(3_000);
  });
});
