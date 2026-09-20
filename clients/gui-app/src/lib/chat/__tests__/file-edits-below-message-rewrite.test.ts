import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  TurnCheckpointManifest,
  TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  hasUndoableFileEditsFromMessage,
  scopedArtifactCountFromMessage,
} from "@/lib/chat/file-edits-below-message";

/**
 * A closing session rewrites a turn's checkpoint: same `turnId`, a NEW
 * `checkpointId`, the earlier entries plus the carried ones. The revert-scope
 * counters must read the turn's LAST manifest only. Counting the superseded one
 * reports an undoable artifact the rewrite already settled as a no-op.
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp: 1000 + messageId.length,
    sessionAnchor: null,
  };
}

const ARTIFACT_PATH = "/repo/artifacts/a/index.md";

function artifactEntry(input: {
  readonly beforeHash: string;
  readonly afterHash: string;
}): TurnCheckpointManifestEntry {
  return {
    filePath: ARTIFACT_PATH,
    operation: "edit",
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    undoable: true,
    reason: null,
    artifact: { artifactId: "a1", kind: "spec", title: "Spec" },
  };
}

function manifest(
  checkpointId: string,
  entries: readonly TurnCheckpointManifestEntry[],
): TurnCheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "owner-1",
    capturingHostId: "host-1",
    allowedRoots: ["/repo"],
    workingDirectory: "/repo",
    capturedAt: 1,
    entries: [...entries],
  };
}

function checkpointEvent(input: {
  readonly eventId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly data: TurnCheckpointManifest;
}): ChatEvent {
  return {
    eventId: input.eventId,
    type: "checkpoint.captured",
    timestamp: input.data.capturedAt,
    clientActionId: null,
    actor: null,
    message: "Checkpoint captured.",
    turnId: input.turnId,
    messageId: input.messageId,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: { ...input.data },
  };
}

describe("revert-scope counters over a rewritten checkpoint", () => {
  const messages = [userMessage("u1")];

  // T's first checkpoint holds an undoable artifact change. Its rewrite (new
  // checkpoint id, same turn) holds the same path as a net no-op: before and
  // after agree, so nothing is left to revert.
  const events: readonly ChatEvent[] = [
    checkpointEvent({
      eventId: "e-first",
      turnId: "turn-1",
      messageId: "u1",
      data: manifest("turn-1", [
        artifactEntry({ beforeHash: "x1", afterHash: "x2" }),
      ]),
    }),
    checkpointEvent({
      eventId: "e-rewrite",
      turnId: "turn-1",
      messageId: "u1",
      data: manifest("checkpoint-rewrite", [
        artifactEntry({ beforeHash: "x2", afterHash: "x2" }),
      ]),
    }),
  ];

  it("counts no artifact once the turn's last manifest settles it as a no-op", () => {
    expect(scopedArtifactCountFromMessage(messages, events, "u1")).toBe(0);
  });

  it("reports no undoable edit once the turn's last manifest has none", () => {
    expect(hasUndoableFileEditsFromMessage(messages, events, "u1")).toBe(false);
  });

  it("still counts the artifact when the rewrite is the one that carries it", () => {
    // The control that keeps the pins above honest: reverse the pair and the
    // LAST manifest is the undoable one, so the counters must say 1 / true. A
    // reader that simply dropped every second manifest would pass the two
    // tests above and fail here.
    const reversed = [events[1], events[0]];
    expect(scopedArtifactCountFromMessage(messages, reversed, "u1")).toBe(1);
    expect(hasUndoableFileEditsFromMessage(messages, reversed, "u1")).toBe(
      true,
    );
  });

  it("keeps two different turns apart", () => {
    const twoTurns = [
      ...events,
      checkpointEvent({
        eventId: "e-t2",
        turnId: "turn-2",
        messageId: "u1",
        data: manifest("turn-2", [
          artifactEntry({ beforeHash: "y1", afterHash: "y2" }),
        ]),
      }),
    ];
    expect(scopedArtifactCountFromMessage(messages, twoTurns, "u1")).toBe(1);
    expect(hasUndoableFileEditsFromMessage(messages, twoTurns, "u1")).toBe(
      true,
    );
  });
});
