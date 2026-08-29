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
  editSubmitNeedsRevertPrompt,
  hasUndoableFileEditsFromMessage,
  revertPromptArtifactCount,
  resolveRevertScope,
  scopedArtifactCountFromMessage,
} from "@/lib/chat/file-edits-below-message";
import {
  applyWindowedSnapshot,
  emptyTranscriptWindow,
} from "@/stores/chats/transcript-window";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: CONTENT,
      browserAnnotations: [],
    },
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

describe("resolveRevertScope", () => {
  const messages = [userMessage("u1"), userMessage("u2")];
  const events = [
    checkpointEvent(
      "u2",
      manifest("turn-2", [
        {
          ...entry({
            filePath: "/repo/artifacts/a/index.md",
            beforeHash: "x",
            afterHash: "y",
          }),
          artifact: { artifactId: "a1", kind: "spec", title: "Real" },
        },
      ]),
    ),
  ];

  /**
   * The legacy line hands over no window, and `messages`/`events` there are the
   * whole transcript - so the scope is always known and the two scans answer
   * exactly as they always have.
   */
  it("answers from the records when there is no window", () => {
    expect(
      resolveRevertScope({
        messages,
        events,
        transcriptWindow: null,
        fromMessageId: "u1",
      }),
    ).toEqual({ known: true, hasUndoableFileEdits: true, artifactCount: 1 });
  });

  it("answers from the records when the window holds everything below", () => {
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages, events },
      },
      null,
      null,
    );
    expect(
      resolveRevertScope({
        messages,
        events,
        transcriptWindow: window,
        fromMessageId: "u1",
      }),
    ).toEqual({ known: true, hasUndoableFileEdits: true, artifactCount: 1 });
  });

  /**
   * The regression this exists for. `u1` is rendered - the user is editing it -
   * but the rows below it are not hydrated, so `messages`/`events` carry
   * neither the later turn nor its checkpoint. Both scans would report a clean
   * history: no prompt, and no artifact opt-out for an artifact the host is
   * about to revert.
   */
  it("refuses to answer when the rows below the edit point are cold", () => {
    const window = applyWindowedSnapshot(
      emptyTranscriptWindow(),
      {
        epoch: 1,
        rowCount: 40,
        indexRevision: null,
        tail: {
          fromOrdinal: 38,
          messages: [userMessage("u38"), userMessage("u39")],
          events: [],
        },
      },
      null,
      null,
    );
    expect(
      resolveRevertScope({
        messages: [userMessage("u1")],
        events: [],
        transcriptWindow: window,
        fromMessageId: "u1",
      }),
    ).toEqual({ known: false });
  });
});

describe("editSubmitNeedsRevertPrompt", () => {
  it("prompts when there are undoable edits below the message", () => {
    expect(
      editSubmitNeedsRevertPrompt({
        known: true,
        hasUndoableFileEdits: true,
        artifactCount: 0,
      }),
    ).toBe(true);
  });

  it("submits straight through when the history below is known clean", () => {
    expect(
      editSubmitNeedsRevertPrompt({
        known: true,
        hasUndoableFileEdits: false,
        artifactCount: 0,
      }),
    ).toBe(false);
  });

  /**
   * Skipping the prompt is not neutral - it submits `revertFileChanges: false`,
   * choosing "Don't revert" for the user over edits they never saw. An unknown
   * scope therefore asks.
   */
  it("prompts rather than deciding for the user on an unknown scope", () => {
    expect(editSubmitNeedsRevertPrompt({ known: false })).toBe(true);
  });
});

describe("revertPromptArtifactCount", () => {
  it("shows a known count", () => {
    expect(
      revertPromptArtifactCount({
        known: true,
        hasUndoableFileEdits: true,
        artifactCount: 3,
      }),
    ).toBe(3);
  });

  it("shows a known ZERO as zero, which hides the opt-out", () => {
    expect(
      revertPromptArtifactCount({
        known: true,
        hasUndoableFileEdits: true,
        artifactCount: 0,
      }),
    ).toBe(0);
  });

  /**
   * The collapse this exists to prevent. `0` would hide an opt-out that
   * defaults to CHECKED, so artifacts would be reverted with nothing on screen
   * having offered the choice.
   */
  it("does not collapse an unknown count to zero", () => {
    expect(revertPromptArtifactCount({ known: false })).toBeNull();
  });
});
