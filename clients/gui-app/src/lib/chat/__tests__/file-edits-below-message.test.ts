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

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT },
    timestamp: 1000 + messageId.length,
    sessionAnchor: null,
  };
}

function entry(
  partial: Partial<TurnCheckpointManifestEntry>,
): TurnCheckpointManifestEntry {
  return {
    filePath: "/repo/file.ts",
    operation: "edit",
    beforeHash: null,
    afterHash: null,
    undoable: true,
    reason: null,
    ...partial,
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

// The host stamps the triggering user message id onto the checkpoint event;
// the scoping helpers key off it, so the fixture must mirror that.
function checkpointEvent(
  messageId: string,
  data: TurnCheckpointManifest,
): ChatEvent {
  return {
    eventId: `event:${data.checkpointId}`,
    type: "checkpoint.captured",
    timestamp: data.capturedAt,
    clientActionId: null,
    actor: null,
    message: "Checkpoint captured.",
    turnId: data.checkpointId,
    messageId,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: { ...data },
  };
}

describe("hasUndoableFileEditsFromMessage", () => {
  const messages = [userMessage("u1"), userMessage("u2")];

  it("counts a real undoable edit below the message", () => {
    const events = [
      checkpointEvent(
        "u1",
        manifest("turn-1", [
          entry({ filePath: "/repo/a.ts", beforeHash: "x", afterHash: "y" }),
        ]),
      ),
    ];
    expect(hasUndoableFileEditsFromMessage(messages, events, "u1")).toBe(true);
  });

  it("does NOT count a turn whose only edit is a net-zero no-op", () => {
    const events = [
      checkpointEvent(
        "u2",
        manifest("turn-2", [
          // Touched but left byte-identical: nothing to revert below u2.
          entry({ filePath: "/repo/a.ts", beforeHash: "x", afterHash: "x" }),
        ]),
      ),
    ];
    expect(hasUndoableFileEditsFromMessage(messages, events, "u2")).toBe(false);
  });
});

describe("scopedArtifactCountFromMessage", () => {
  it("excludes net-zero artifacts from the revert count", () => {
    const messages = [userMessage("u1")];
    const events = [
      checkpointEvent(
        "u1",
        manifest("turn-1", [
          {
            ...entry({
              filePath: "/repo/artifacts/a/index.md",
              beforeHash: "x",
              afterHash: "y",
            }),
            artifact: { artifactId: "a1", kind: "spec", title: "Real" },
          },
          {
            ...entry({
              filePath: "/repo/artifacts/b/index.md",
              beforeHash: "z",
              afterHash: "z",
            }),
            artifact: { artifactId: "b1", kind: "spec", title: "No-op" },
          },
        ]),
      ),
    ];
    // Only the artifact with an actual change is counted.
    expect(scopedArtifactCountFromMessage(messages, events, "u1")).toBe(1);
  });
});
