import { describe, expect, it } from "vitest";
import { chatActiveTurnSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  advanceTurnNotify,
  seedTurnNotifyState,
  toChatTurnPhase,
  INITIAL_TURN_NOTIFY_STATE,
  type ChatTurnPhase,
  type TurnNotifyState,
} from "@/lib/chats/chat-turn-completions";

function phase(overrides: Partial<ChatTurnPhase>): ChatTurnPhase {
  return {
    runningTurn: false,
    stopping: false,
    turnEnded: false,
    connectionClosed: false,
    ...overrides,
  };
}

const RUNNING = phase({ runningTurn: true });
const STOPPING = phase({ stopping: true });
const TURN_ENDED = phase({ turnEnded: true });
const CLOSED = phase({ connectionClosed: true, turnEnded: true });

function runSequence(
  seed: ChatTurnPhase,
  steps: ReadonlyArray<ChatTurnPhase>,
): ReadonlyArray<boolean> {
  let state: TurnNotifyState = seedTurnNotifyState(seed);
  return steps.map((step) => {
    const result = advanceTurnNotify(state, step);
    state = result.state;
    return result.completed;
  });
}

describe("advanceTurnNotify", () => {
  it("fires once when a running turn ends", () => {
    const afterRun = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING);
    expect(afterRun.completed).toBe(false);
    expect(afterRun.state.armed).toBe(true);

    const afterEnd = advanceTurnNotify(afterRun.state, TURN_ENDED);
    expect(afterEnd.completed).toBe(true);
    expect(afterEnd.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire on a closed socket and drops the latch", () => {
    const armed = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING).state;
    const afterClose = advanceTurnNotify(armed, CLOSED);
    expect(afterClose.completed).toBe(false);
    expect(afterClose.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire for a user-initiated stop", () => {
    expect(runSequence(TURN_ENDED, [RUNNING, STOPPING, TURN_ENDED])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("stays armed across an intermediate frame before the turn ends", () => {
    const runningWithoutActiveTurn = phase({ turnEnded: false });
    expect(
      runSequence(TURN_ENDED, [RUNNING, runningWithoutActiveTurn, TURN_ENDED]),
    ).toEqual([false, false, true]);
  });

  it("counts a turn already running when first observed", () => {
    expect(runSequence(RUNNING, [TURN_ENDED])).toEqual([true]);
  });

  it("does not fire on reconnect until a turn runs again", () => {
    expect(runSequence(TURN_ENDED, [RUNNING, CLOSED, TURN_ENDED])).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      runSequence(TURN_ENDED, [RUNNING, CLOSED, RUNNING, TURN_ENDED]),
    ).toEqual([false, false, false, true]);
  });
});

describe("toChatTurnPhase", () => {
  const activeTurn = chatActiveTurnSchema.parse({
    turnId: "turn-1",
    status: "running",
    harnessId: "claude",
    model: "claude-opus",
    userMessageId: "msg-1",
    startedAt: 0,
    updatedAt: 0,
  });

  it("projects a running turn", () => {
    expect(
      toChatTurnPhase({
        runStatus: "running",
        activeTurn,
        queue: { status: "idle", items: [] },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: true,
      stopping: false,
      turnEnded: false,
      connectionClosed: false,
    });
  });

  it("projects an ended turn in a connected chat", () => {
    expect(
      toChatTurnPhase({
        runStatus: "idle",
        activeTurn: null,
        queue: { status: "idle", items: [] },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: false,
      stopping: false,
      turnEnded: true,
      connectionClosed: false,
    });
  });

  it("projects an errored turn as complete while its queued messages remain paused", () => {
    expect(
      toChatTurnPhase({
        runStatus: "idle",
        activeTurn: null,
        queue: {
          status: "paused",
          items: [
            {
              kind: "prompt",
              queueItemId: "queued-after-error",
              messageId: "message-2",
              message: {
                kind: "user",
                content: {
                  type: "doc",
                  content: [{ type: "paragraph" }],
                },
                browserAnnotations: [],
              },
              sender: { type: "user", userId: "user-1" },
              settings: {
                harnessId: "claude",
                model: "claude-opus",
                permissionMode: "supervised",
                reasoningEffort: null,
                serviceTier: null,
                agentMode: "regular",
                profileId: "work",
              },
              accountContext: { type: "PERSONAL" },
              delivery: "next_turn",
              status: "paused",
              targetTurnId: null,
              steerRequest: null,
              fallbackReason: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: false,
      stopping: false,
      turnEnded: true,
      connectionClosed: false,
    });
  });
});
