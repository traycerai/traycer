import { describe, expect, it } from "vitest";
import type {
  ChatEvent,
  ChatEventType,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  partitionSetupCardWindows,
  SETUP_DERIVATION_EVENT_TYPES,
} from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";
import { selectRestorableSetupInterruption } from "@traycer/protocol/persistence/chat-transcript/setup-interruption";

/**
 * A store reads the setup derivations' input by TYPE
 * (`SETUP_DERIVATION_EVENT_TYPES`) instead of walking the event log. That is
 * sound only if both derivations answer the same over the filtered events, in
 * order, as over all of them.
 */

function event(fields: {
  eventId: string;
  type: ChatEventType;
  timestamp: number;
  messageId: string | null;
  metadata: Record<string, unknown> | null;
}): ChatEvent {
  return {
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    clientActionId: `act-${fields.eventId}`,
    actor: null,
    message: null,
    turnId: null,
    messageId: fields.messageId,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: fields.metadata,
  };
}

function setup(
  eventId: string,
  type: ChatEventType,
  timestamp: number,
  workspacePath: string | null,
  messageId: string | null,
  extra: Record<string, unknown>,
): ChatEvent {
  return event({
    eventId,
    type,
    timestamp,
    messageId,
    metadata:
      workspacePath === null ? { ...extra } : { workspacePath, ...extra },
  });
}

function unrelated(
  eventId: string,
  type: ChatEventType,
  timestamp: number,
): ChatEvent {
  return event({ eventId, type, timestamp, messageId: "m-x", metadata: null });
}

const rawLog: readonly ChatEvent[] = [
  unrelated("e01", "send.accepted", 1),
  setup("e02", "setup.running", 2, "/ws/a", null, {}),
  unrelated("e03", "turn.started", 3),
  setup("e04", "setup.failed", 4, "/ws/a", "msg-1", {
    terminalSessionId: "term-1",
    setupExitCode: 2,
  }),
  unrelated("e05", "queue.added", 5),
  setup("e06", "setup.failed", 6, null, "msg-path-less", {}),
  event({
    eventId: "e07",
    type: "chat.forked",
    timestamp: 7,
    messageId: null,
    metadata: { sourceChatId: "chat-src" },
  }),
  setup("e08", "setup.running", 8, "/ws/a", null, {}),
  setup("e09", "setup.succeeded", 9, "/ws/a", null, {}),
  unrelated("e10", "approval.requested", 10),
  event({
    eventId: "e11",
    type: "worktree.missing",
    timestamp: 11,
    messageId: null,
    metadata: null,
  }),
  setup("e12", "setup.creating", 12, "/ws/b", "msg-2", {
    triggeringMessageId: "msg-2",
  }),
  setup("e13", "setup.running", 13, "/ws/b", null, {}),
  unrelated("e14", "harness.error", 14),
  setup("e15", "setup.cancelled", 15, "/ws/b", "msg-3", {}),
  unrelated("e16", "turn.completed", 16),
];

function filtered(events: readonly ChatEvent[]): readonly ChatEvent[] {
  return events.filter((candidate) =>
    SETUP_DERIVATION_EVENT_TYPES.includes(candidate.type),
  );
}

/** Each prefix of the log is its own scenario: every intermediate answer must hold. */
function prefixes(): ReadonlyArray<readonly ChatEvent[]> {
  const result: Array<readonly ChatEvent[]> = [];
  for (let end = 0; end <= rawLog.length; end += 1) {
    result.push(rawLog.slice(0, end));
  }
  return result;
}

describe("SETUP_DERIVATION_EVENT_TYPES filter parity", () => {
  it("the filter actually removes events and keeps chat.forked and worktree.missing", () => {
    const kept = filtered(rawLog);
    expect(kept.length).toBeLessThan(rawLog.length);
    expect(kept.some((e) => e.type === "chat.forked")).toBe(true);
    expect(kept.some((e) => e.type === "worktree.missing")).toBe(true);
    expect(kept.some((e) => e.type === "send.accepted")).toBe(false);
  });

  it("partitionSetupCardWindows answers the same over the filtered events, at every prefix", () => {
    for (const events of prefixes()) {
      expect(partitionSetupCardWindows(filtered(events))).toEqual(
        partitionSetupCardWindows(events),
      );
    }
  });

  it("selectRestorableSetupInterruption answers the same over the filtered events, at every prefix", () => {
    for (const events of prefixes()) {
      expect(selectRestorableSetupInterruption(filtered(events))).toEqual(
        selectRestorableSetupInterruption(events),
      );
    }
  });

  it("the whole log yields non-trivial answers for both derivations", () => {
    expect(partitionSetupCardWindows(rawLog).length).toBeGreaterThanOrEqual(2);
    expect(selectRestorableSetupInterruption(rawLog)).toEqual(
      expect.objectContaining({ eventId: "e15", messageId: "msg-3" }),
    );
  });

  it("a fork before the setup changes the genesis pin identically on both inputs", () => {
    const forkFirst: readonly ChatEvent[] = [
      unrelated("f0", "send.accepted", 1),
      event({
        eventId: "f1",
        type: "chat.forked",
        timestamp: 2,
        messageId: null,
        metadata: null,
      }),
      setup("f2", "setup.running", 3, "/ws/c", null, {}),
      unrelated("f3", "turn.started", 4),
    ];
    const noFork: readonly ChatEvent[] = [
      unrelated("g0", "send.accepted", 1),
      setup("g2", "setup.running", 3, "/ws/c", null, {}),
    ];
    for (const events of [forkFirst, noFork]) {
      expect(partitionSetupCardWindows(filtered(events))).toEqual(
        partitionSetupCardWindows(events),
      );
    }
    expect(partitionSetupCardWindows(forkFirst)[0]?.isGenesisPin).toBe(false);
    expect(partitionSetupCardWindows(noFork)[0]?.isGenesisPin).toBe(true);
  });
});
