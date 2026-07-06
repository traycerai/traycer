import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  chatEventTypeSchema,
  chatSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  restoreResultManifestSchema,
  restoreStartedManifestSchema,
  turnCheckpointManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";

const epicSchema = getRecordSchema(persistenceRecordRegistry, "epic", "latest");

const chatWithoutEvents = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "host-1",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  sessionRef: null,
  messages: [],
};

const chatEvent = {
  eventId: "event-1",
  type: "turn.stopped",
  timestamp: 1001,
  clientActionId: "action-1",
  actor: { type: "user", userId: "user-1" },
  message: "Turn stopped",
  turnId: "turn-1",
  messageId: null,
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "warning",
  metadata: { harnessId: "codex" },
};

describe("ChatEvent persistence schema", () => {
  it("lists each checkpoint event type exactly once", () => {
    const counts = new Map<string, number>();
    for (const option of chatEventTypeSchema.options) {
      counts.set(option, (counts.get(option) ?? 0) + 1);
    }
    expect(counts.get("checkpoint.captured")).toBe(1);
    expect(counts.get("checkpoint.restoreStarted")).toBe(1);
    expect(counts.get("checkpoint.restored")).toBe(1);
  });

  it("accepts lifecycle/control events and excludes per-block deltas", () => {
    expect(chatEventSchema.parse(chatEvent)).toMatchObject({
      type: "turn.stopped",
      turnId: "turn-1",
    });

    expect(() =>
      chatEventSchema.parse({
        ...chatEvent,
        type: "block.delta",
      }),
    ).toThrow();
  });

  it("keeps existing V200 chats without events or wakes readable as empty arrays", () => {
    const parsed = chatSchema.parse(chatWithoutEvents);

    expect(parsed.events).toEqual([]);
    expect(parsed.claudePendingWakes).toEqual([]);
  });

  it("accepts checkpoint events with typed metadata manifests", () => {
    const capturedManifest = turnCheckpointManifestSchema.parse({
      schemaVersion: 1,
      checkpointId: "turn-1",
      capturingUserId: "user-1",
      capturingHostId: "host-1",
      allowedRoots: ["/repo", "/repo/packages"],
      workingDirectory: "/repo",
      capturedAt: 1002,
      entries: [
        {
          filePath: "/repo/src/app.ts",
          operation: "edit",
          beforeHash: "before",
          afterHash: "after",
          undoable: true,
          reason: null,
        },
      ],
    });
    const restoreStartedManifest = restoreStartedManifestSchema.parse({
      checkpointId: "turn-1",
      restoringUserId: "user-1",
      restoringHostId: "host-1",
      startedAt: 1003,
    });
    const restoreResultManifest = restoreResultManifestSchema.parse({
      checkpointId: "turn-1",
      restoredAt: 1004,
      results: [
        {
          filePath: "/repo/src/app.ts",
          status: "restored",
          operation: "edit",
          reason: null,
        },
      ],
    });

    expect(
      chatEventSchema.parse({
        ...chatEvent,
        eventId: "event-checkpoint-captured",
        type: "checkpoint.captured",
        metadata: capturedManifest,
      }),
    ).toMatchObject({ type: "checkpoint.captured" });
    expect(
      chatEventSchema.parse({
        ...chatEvent,
        eventId: "event-checkpoint-restore-started",
        type: "checkpoint.restoreStarted",
        metadata: restoreStartedManifest,
      }),
    ).toMatchObject({ type: "checkpoint.restoreStarted" });
    expect(
      chatEventSchema.parse({
        ...chatEvent,
        eventId: "event-checkpoint-restored",
        type: "checkpoint.restored",
        metadata: restoreResultManifest,
      }),
    ).toMatchObject({ type: "checkpoint.restored" });
  });

  it("parses epics with missing and initialized chat event timelines", () => {
    const parsed = epicSchema.parse({
      id: "epic-1",
      title: "Epic",
      isTitleEditedByUser: false,
      createdAt: 1000,
      updatedAt: 1000,
      chats: {
        "chat-1": chatWithoutEvents,
        "chat-2": {
          ...chatWithoutEvents,
          id: "chat-2",
          events: [chatEvent],
        },
      },
      artifacts: {},
      deletedArtifacts: {},
    });

    expect(parsed.chats["chat-1"].events).toEqual([]);
    expect(parsed.chats["chat-1"].claudePendingWakes).toEqual([]);
    expect(parsed.chats["chat-2"].events).toHaveLength(1);
  });
});
