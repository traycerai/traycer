import { describe, expect, it } from "vitest";
import { chatActiveTurnSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  advanceTurnNotify,
  seedTurnNotifyState,
  toChatTurnPhase,
  INITIAL_TURN_NOTIFY_STATE,
  type ChatTurnPhase,
  type TurnNotifyState,
} from "@/lib/notifications/chat-turn-completion";

function phase(overrides: Partial<ChatTurnPhase>): ChatTurnPhase {
  return {
    runningTurn: false,
    stopping: false,
    settled: false,
    connectionClosed: false,
    ...overrides,
  };
}

const RUNNING = phase({ runningTurn: true });
const STOPPING = phase({ stopping: true });
const SETTLED = phase({ settled: true });
const CLOSED = phase({ connectionClosed: true, settled: true });

/**
 * Drive a seeded latch through a sequence of phases the way the live per-handle
 * listener does, collecting which steps reported a completion.
 */
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
  it("fires once on the running → fully-settled edge", () => {
    const afterRun = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING);
    expect(afterRun.completed).toBe(false);
    expect(afterRun.state.armed).toBe(true);

    const afterSettle = advanceTurnNotify(afterRun.state, SETTLED);
    expect(afterSettle.completed).toBe(true);
    expect(afterSettle.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire on a closed socket and drops the latch (no false 'Done')", () => {
    const armed = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING).state;
    const afterClose = advanceTurnNotify(armed, CLOSED);
    expect(afterClose.completed).toBe(false);
    expect(afterClose.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire for a user-initiated stop", () => {
    expect(runSequence(SETTLED, [RUNNING, STOPPING, SETTLED])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("does not fire from the turn-startup window (running but no active turn)", () => {
    const startup = phase({ runningTurn: false });
    expect(runSequence(SETTLED, [startup, SETTLED])).toEqual([false, false]);
  });

  it("fires once when a queued run drains across two frames", () => {
    // runStatus settles in one frame (queue still busy → not settled) and the
    // queue empties in the next; the latch must survive the gap.
    const runStatusSettledQueueBusy = phase({ settled: false });
    expect(
      runSequence(SETTLED, [RUNNING, runStatusSettledQueueBusy, SETTLED]),
    ).toEqual([false, false, true]);
  });

  it("counts a turn already running when first observed (seed)", () => {
    expect(runSequence(RUNNING, [SETTLED])).toEqual([true]);
  });

  it("does not fire on reconnect for a turn whose running frame was lost to a close, until it runs again", () => {
    expect(runSequence(SETTLED, [RUNNING, CLOSED, SETTLED])).toEqual([
      false,
      false,
      false,
    ]);
    expect(runSequence(SETTLED, [RUNNING, CLOSED, RUNNING, SETTLED])).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("never fires from a quiet idle baseline", () => {
    expect(runSequence(SETTLED, [SETTLED, SETTLED])).toEqual([false, false]);
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
      settled: false,
      connectionClosed: false,
    });
  });

  it("projects a fully-settled, connected chat", () => {
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
      settled: true,
      connectionClosed: false,
    });
  });

  it("flags a closed socket", () => {
    expect(
      toChatTurnPhase({
        runStatus: "idle",
        activeTurn: null,
        queue: { status: "idle", items: [] },
        connectionStatus: "closed",
      }).connectionClosed,
    ).toBe(true);
  });
});
