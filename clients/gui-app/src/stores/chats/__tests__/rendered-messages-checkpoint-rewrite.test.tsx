import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TurnCheckpointManifest } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  AgentSender,
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

/**
 * The legacy line: no row context, so `hasLaterOverlappingChanges` on a turn's
 * `file_change_group` comes from the renderer's own derivation over `events`.
 * A closing session rewrites a turn's checkpoint (same `turnId`, new
 * `checkpointId`); the turn must not be flagged by its own rewrite, and a
 * genuinely later turn must still flag it.
 */

const ASSISTANT_SENDER: AgentSender = {
  type: "agent" as const,
  harnessId: "claude" as const,
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

const FILE = "/repo/src/app.ts";

function assistantTurn(
  turnId: string,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: turnId,
    sender: ASSISTANT_SENDER,
    blocks: [
      {
        type: "file_change",
        blockId: `file:${turnId}`,
        filePath: FILE,
        operation: "edit",
        diffSource: "snapshot",
        beforeHash: "a".repeat(64),
        afterHash: "b".repeat(64),
        additions: 1,
        deletions: 1,
        reason: "snapshot",
        status: "completed",
        timestamp: timestamp + 1,
      },
    ],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function manifest(
  checkpointId: string,
  beforeHash: string,
  afterHash: string,
): TurnCheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "owner-1",
    capturingHostId: "host-1",
    allowedRoots: ["/repo"],
    workingDirectory: "/repo",
    capturedAt: 2000,
    entries: [
      {
        filePath: FILE,
        operation: "edit",
        beforeHash,
        afterHash,
        undoable: true,
        reason: null,
      },
    ],
  };
}

function checkpointEvent(
  eventId: string,
  turnId: string,
  data: TurnCheckpointManifest,
): ChatEvent {
  return {
    eventId,
    type: "checkpoint.captured",
    timestamp: data.capturedAt,
    clientActionId: null,
    actor: null,
    message: "Checkpoint captured.",
    turnId,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: { ...data },
  };
}

function inputWith(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): RenderedMessagesInput {
  return {
    messages: [...messages],
    events: [...events],
    rowContext: {},
    pendingUserMessages: [],
    liveAssistantMessage: null,
    activeTurn: null,
    runStatus: "idle",
    setupCardWindows: [],
    epicId: "epic-1",
    ownerId: "owner-1",
    ownerKind: "chat",
    viewTabId: "tab-1",
  };
}

/** The `file_change_group` a turn's assistant row ends with. */
function groupOf(
  messages: readonly Message[],
  events: readonly ChatEvent[],
  turnId: string,
) {
  const { result } = renderHook(() =>
    useRenderedMessages(inputWith(messages, events), displayContext),
  );
  const row = result.current.find(
    (message) =>
      message.role === "assistant" && message.id === `assistant:${turnId}`,
  );
  if (row === undefined) throw new Error(`no assistant row for ${turnId}`);
  const group = row.segments[row.segments.length - 1];
  if (group.kind !== "file_change_group") {
    throw new Error("expected a file change group");
  }
  return group;
}

describe("legacy-line overlap over a rewritten checkpoint", () => {
  it("does not flag a turn by its own rewrite (same turnId, new checkpointId)", () => {
    const group = groupOf(
      [assistantTurn("turn-1", 2000)],
      [
        checkpointEvent(
          "e-first",
          "turn-1",
          manifest("turn-1", "before", "after"),
        ),
        checkpointEvent(
          "e-rewrite",
          "turn-1",
          manifest("checkpoint-rewrite", "before", "after"),
        ),
      ],
      "turn-1",
    );
    // The group renders the LAST manifest, and that one has nothing after it.
    expect(group.checkpointManifest?.checkpointId).toBe("checkpoint-rewrite");
    expect(group.hasLaterOverlappingChanges).toBe(false);
  });

  it("still flags the turn when a genuinely later turn touches the same file", () => {
    const group = groupOf(
      [assistantTurn("turn-1", 2000), assistantTurn("turn-2", 3000)],
      [
        checkpointEvent(
          "e-first",
          "turn-1",
          manifest("turn-1", "before", "after"),
        ),
        checkpointEvent(
          "e-rewrite",
          "turn-1",
          manifest("checkpoint-rewrite", "before", "after"),
        ),
        checkpointEvent(
          "e-later",
          "turn-2",
          manifest("turn-2", "before", "after"),
        ),
      ],
      "turn-1",
    );
    expect(group.checkpointManifest?.checkpointId).toBe("checkpoint-rewrite");
    expect(group.hasLaterOverlappingChanges).toBe(true);
  });

  it("renders the rewrite, not the superseded manifest, for a turn with no later turn", () => {
    const group = groupOf(
      [assistantTurn("turn-1", 2000), assistantTurn("turn-2", 3000)],
      [
        checkpointEvent(
          "e-first",
          "turn-1",
          manifest("turn-1", "before", "after"),
        ),
        checkpointEvent(
          "e-later",
          "turn-2",
          manifest("turn-2", "before", "after"),
        ),
        checkpointEvent(
          "e-later-rewrite",
          "turn-2",
          manifest("turn-2-rewrite", "before", "after"),
        ),
      ],
      "turn-2",
    );
    expect(group.checkpointManifest?.checkpointId).toBe("turn-2-rewrite");
    expect(group.hasLaterOverlappingChanges).toBe(false);
  });

  it("does not flag an earlier turn by a later turn's SUPERSEDED manifest", () => {
    // turn-2 first touched the file for real; its rewrite settles the same
    // path as a net no-op. Only turn-2's last manifest counts, and a no-op
    // drives no note, so nothing after turn-1 rewrites its file.
    const group = groupOf(
      [assistantTurn("turn-1", 2000), assistantTurn("turn-2", 3000)],
      [
        checkpointEvent(
          "e-t1",
          "turn-1",
          manifest("turn-1", "before", "after"),
        ),
        checkpointEvent("e-t2", "turn-2", manifest("turn-2", "after", "later")),
        checkpointEvent(
          "e-t2-rewrite",
          "turn-2",
          manifest("turn-2-rewrite", "later", "later"),
        ),
      ],
      "turn-1",
    );
    expect(group.hasLaterOverlappingChanges).toBe(false);
  });
});
