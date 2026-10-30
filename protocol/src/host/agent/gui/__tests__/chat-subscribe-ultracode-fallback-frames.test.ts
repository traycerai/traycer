import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatSubscribeV140,
  chatSubscribeV141,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * Below `chat.subscribe@1.41` no tuple the host sends may carry the per-chat
 * Ultracode request: the chat record's settings, the fallback's failed, target,
 * impending and preferred tuples, and the last failed attempt's tuple. Each is
 * a separate carrier with its own projection, so each is read on its own, and
 * the projection must leave everything around the tuple as it was.
 */

const V140: SchemaVersion = { major: 1, minor: 40 };
const V141: SchemaVersion = { major: 1, minor: 41 };

function tuple(model: string) {
  return {
    harnessId: "claude" as const,
    model,
    permissionMode: "full_access" as const,
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular" as const,
    profileId: null,
    ultracode: true,
  };
}

function pendingFallback() {
  return {
    traversalId: "traversal-1",
    revision: 3,
    state: "choosing" as const,
    reason: "rate_limited",
    failedTuple: tuple("claude-sonnet-5"),
    targetTuple: tuple("claude-opus-5"),
    impendingAction: {
      planId: "plan-1",
      rung: "profile" as const,
      target: tuple("claude-opus-5"),
      targetModelFamily: null,
      resumesAt: null,
      pending: null,
    },
    deadline: 1_700_000_000_000,
    graceRemainingMs: 5_000,
    attempt: 2,
    maxAttempts: 5,
    queuedItemsMoving: 4,
    siblingSwitching: 1,
  };
}

function pendingReturn() {
  return {
    traversalId: "traversal-return-1",
    revision: 4,
    preferredTuple: tuple("claude-sonnet-5"),
    fallbackTuple: tuple("claude-opus-5"),
    queuedItemsMoving: 2,
    offeredAt: 1_700_000_000_000,
  };
}

function lastFailedAttempt() {
  return {
    userMessageId: "user-message-1",
    turnId: "turn-1",
    failure: {
      reason: "rate_limit",
      resetsAt: 1_700_000_600_000,
      resetsAtSource: "provider",
      scope: "five_hour",
      providerDetail: "code=rate_limit_exceeded",
    },
    eligibleRungs: ["retry", "switch", "wait_once"],
    waitDisposition: "eligible" as const,
    switchDisposition: "eligible" as const,
    failedTuple: tuple("claude-sonnet-5"),
    waitResumesAt: 1_700_000_600_000 + 105_000,
  };
}

const envelope = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
};

function windowedSnapshot(): Record<string, unknown> {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
        settings: tuple("claude-sonnet-5"),
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
      pendingFallback: pendingFallback(),
      pendingReturn: pendingReturn(),
      lastFailedAttempt: lastFailedAttempt(),
    },
  };
}

function turnStateChanged(): Record<string, unknown> {
  return {
    kind: "turnStateChanged",
    ...envelope,
    runStatus: "running",
    activeTurn: null,
    pendingFallback: pendingFallback(),
    pendingReturn: pendingReturn(),
    lastFailedAttempt: lastFailedAttempt(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected object for ${label}`);
  return value;
}

function live(
  frame: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  const parsed = chatSubscribeV141.serverFrameSchema.parse(frame);
  if (parsed.hasBinaryPayload !== false) throw new Error("expected text frame");
  return parsed;
}

/** Every tuple slot the frame carries, with the path that names it. */
function tupleSlots(frame: unknown): Record<string, unknown> {
  const root = asRecord(frame, "frame");
  const body =
    root.kind === "snapshot" ? asRecord(root.snapshot, "snapshot") : root;
  const fallback = asRecord(body.pendingFallback, "pendingFallback");
  const slots: Record<string, unknown> = {
    failed: fallback.failedTuple,
    target: fallback.targetTuple,
    impending: asRecord(fallback.impendingAction, "impendingAction").target,
    preferred: asRecord(body.pendingReturn, "pendingReturn").preferredTuple,
    returnFallback: asRecord(body.pendingReturn, "pendingReturn").fallbackTuple,
    lastFailed: asRecord(body.lastFailedAttempt, "lastFailedAttempt")
      .failedTuple,
  };
  if (root.kind === "snapshot") {
    slots.chat = asRecord(body.chat, "chat").settings;
  }
  return slots;
}

function withoutUltracode(
  slots: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(slots).map(([name, value]) => {
      const { ultracode: _dropped, ...rest } = asRecord(value, name);
      return [name, rest];
    }),
  );
}

const FRAMES = [
  { name: "snapshot", frame: windowedSnapshot },
  { name: "turnStateChanged", frame: turnStateChanged },
] as const;

describe.each(FRAMES)("a $name frame's tuples", ({ name, frame }) => {
  it("carries the request in every slot on the live line", () => {
    const slots = tupleSlots(live(frame()));
    for (const [slot, value] of Object.entries(slots)) {
      expect(asRecord(value, slot).ultracode, slot).toBe(true);
    }
  });

  it("loses it in every slot below 1.41 and nothing else, and the result parses on the frozen line", () => {
    const original = live(frame());
    const projected = projectChatServerFrameForVersion(original, V140);

    expect(tupleSlots(projected)).toEqual(
      withoutUltracode(tupleSlots(original)),
    );
    expect(chatSubscribeV140.serverFrameSchema.parse(projected).kind).toBe(
      name,
    );
    // Around the tuples: the fallback and attempt records are untouched.
    const fallbackBefore = asRecord(
      name === "snapshot"
        ? asRecord(asRecord(original, "frame").snapshot, "snapshot")
            .pendingFallback
        : asRecord(original, "frame").pendingFallback,
      "fallback",
    );
    const fallbackAfter = asRecord(
      name === "snapshot"
        ? asRecord(asRecord(projected, "frame").snapshot, "snapshot")
            .pendingFallback
        : asRecord(projected, "frame").pendingFallback,
      "fallback",
    );
    expect(fallbackAfter.attempt).toBe(fallbackBefore.attempt);
    expect(fallbackAfter.traversalId).toBe(fallbackBefore.traversalId);
  });

  it("is returned as it was on 1.41", () => {
    const original = live(frame());
    expect(projectChatServerFrameForVersion(original, V141)).toEqual(original);
  });
});
