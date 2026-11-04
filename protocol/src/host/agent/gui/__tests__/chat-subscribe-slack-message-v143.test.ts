import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatSubscribeV142,
  chatSubscribeV143,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `chat.subscribe@1.43` adds the `slack` user message. Every line below it
 * binds a payload union without the kind, so the projector degrades each
 * Slack message to the plain user message a person would have typed: one
 * line naming who wrote it in Slack, then the text and images. `1.43` sees
 * the message untouched.
 */

const SLACK_AWARE: SchemaVersion = { major: 1, minor: 43 };
const DOWNGRADED_MINORS = [30, 41, 42] as const;

function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected object for ${label}`);
  return parsed.data;
}

function asArray(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`expected array for ${label}`);
  return value;
}

const BODY = [
  { type: "paragraph", content: [{ type: "text", text: "what is this?" }] },
  {
    type: "paragraph",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          hash: "a".repeat(64),
          fileName: "shot.png",
          mimeType: "image/png",
        },
      },
    ],
  },
];

function slackPayload(displayName: string | null): Record<string, unknown> {
  return {
    kind: "slack",
    content: { type: "doc", content: BODY },
    author: { displayName, slackUserId: "U0PRIYA01", traycerUserId: null },
    ts: "1760000010.000100",
    trigger: "mention",
    followUp: false,
    omitted: [{ fileName: "plans.pdf", reason: "unsupported_type" }],
  };
}

/** The user message a peer below 1.43 reads for a Slack message from `name`. */
function degraded(name: string): Record<string, unknown> {
  return {
    kind: "user",
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: `${name} in Slack:` }],
        },
        ...BODY,
      ],
    },
    browserAnnotations: [],
  };
}

function userRow(message: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "user",
    messageId: "slack-message:1760000010.000100",
    sender: { type: "user", userId: "user-1" },
    message,
    timestamp: 5,
    sessionAnchor: null,
  };
}

function queueOf(message: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "idle",
    items: [
      {
        kind: "prompt",
        queueItemId: "queue-1",
        messageId: "slack-message:1760000010.000100",
        message,
        sender: { type: "user", userId: "user-1" },
        settings: {
          harnessId: "codex",
          model: "gpt-5.4",
          permissionMode: "supervised",
          reasoningEffort: "high",
          agentMode: "epic",
        },
        accountContext: { type: "PERSONAL" },
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

function serverFrame(
  body: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  const kind = body.kind;
  if (typeof kind !== "string") throw new Error("expected frame kind");
  return {
    ...body,
    kind,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
  };
}

function messageAcceptedFrame(message: Record<string, unknown>) {
  return serverFrame({ kind: "messageAccepted", message: userRow(message) });
}

function queueChangedFrame(message: Record<string, unknown>) {
  return serverFrame({ kind: "queueChanged", queue: queueOf(message) });
}

function rangeFrame(message: Record<string, unknown>) {
  return serverFrame({
    kind: "range",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["slack-message:1760000010.000100"],
      messages: [userRow(message)],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

function snapshotFrame(
  message: Record<string, unknown>,
  queueMessage: Record<string, unknown>,
) {
  return serverFrame({
    kind: "snapshot",
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
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: queueOf(queueMessage),
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [userRow(message)], events: [] },
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
    },
  });
}

/** The prompt item a queue event embeds, under `metadata.item` or `.items`. */
function promptItemOf(message: Record<string, unknown>): unknown {
  return asArray(queueOf(message).items, "items")[0];
}

function queueEvent(
  type: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId: "e-queue",
    type,
    timestamp: 1,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
  };
}

function eventAppendedFrame(event: Record<string, unknown>) {
  return serverFrame({ kind: "eventAppended", event });
}

function rangeEventFrame(event: Record<string, unknown>) {
  return serverFrame({
    kind: "range",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: [],
      messages: [],
      events: [event],
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

function snapshotTailEventFrame(event: Record<string, unknown>) {
  const frame = snapshotFrame(slackPayload("Priya"), slackPayload("Priya"));
  const snapshot = asRecord(frame.snapshot, "snapshot");
  return {
    ...frame,
    snapshot: {
      ...snapshot,
      tail: { fromOrdinal: 0, messages: [], events: [event] },
      queue: { status: "idle", items: [] },
    },
  };
}

function snapshotChatEventFrame(event: Record<string, unknown>) {
  const frame = snapshotFrame(slackPayload("Priya"), slackPayload("Priya"));
  const snapshot = asRecord(frame.snapshot, "snapshot");
  return {
    ...frame,
    snapshot: {
      ...snapshot,
      chat: { ...asRecord(snapshot.chat, "chat"), events: [event] },
      tail: { fromOrdinal: 0, messages: [], events: [] },
      queue: { status: "idle", items: [] },
    },
  };
}

/** The projected event, wherever its carrier holds it. */
function eventOfFrame(projected: unknown): unknown {
  const frame = asRecord(projected, "frame");
  if (frame.kind === "eventAppended") return frame.event;
  if (frame.kind === "range") {
    return asArray(asRecord(frame.range, "range").events, "events")[0];
  }
  const snapshot = asRecord(frame.snapshot, "snapshot");
  const tail = asArray(asRecord(snapshot.tail, "tail").events, "events");
  return tail.length > 0
    ? tail[0]
    : asArray(asRecord(snapshot.chat, "chat").events, "events")[0];
}

/** The payload an event embeds, under `metadata.item` or `metadata.items`. */
function eventMessageOf(event: unknown): unknown {
  const metadata = asRecord(asRecord(event, "event").metadata, "metadata");
  const item =
    "item" in metadata
      ? metadata.item
      : asArray(metadata.items, "metadata.items")[0];
  return asRecord(item, "item").message;
}

const EVENT_CARRIERS = [
  ["eventAppended", eventAppendedFrame],
  ["a range's events", rangeEventFrame],
  ["a snapshot's tail.events", snapshotTailEventFrame],
  ["a whole snapshot's chat.events", snapshotChatEventFrame],
] as const;

const QUEUE_EVENTS = [
  [
    "queue.added under metadata.item",
    () =>
      queueEvent("queue.added", { item: promptItemOf(slackPayload("Priya")) }),
  ],
  [
    "queue.paused under metadata.items",
    () =>
      queueEvent("queue.paused", {
        items: [promptItemOf(slackPayload("Priya"))],
      }),
  ],
] as const;

function firstMessageOf(messages: unknown): unknown {
  return asRecord(asArray(messages, "messages")[0], "row").message;
}

function queueMessageOf(queue: unknown): unknown {
  const items = asArray(asRecord(queue, "queue").items, "items");
  return asRecord(items[0], "item").message;
}

describe("chat.subscribe server frame projection of a Slack message", () => {
  describe.each(DOWNGRADED_MINORS)("to chat.subscribe@1.%i", (minor) => {
    const negotiated = version(minor);

    it("degrades the accepted row to a user message naming the author, and the 1.42 line parses it", () => {
      const projected = projectChatServerFrameForVersion(
        messageAcceptedFrame(slackPayload("Priya")),
        negotiated,
      );

      expect(
        asRecord(asRecord(projected, "frame").message, "row").message,
      ).toEqual(degraded("Priya"));
      expect(
        chatSubscribeV142.serverFrameSchema.safeParse(projected).success,
      ).toBe(true);
    });

    it("names an author Slack gave no name for as Someone", () => {
      const projected = projectChatServerFrameForVersion(
        messageAcceptedFrame(slackPayload(null)),
        negotiated,
      );

      expect(
        asRecord(asRecord(projected, "frame").message, "row").message,
      ).toEqual(degraded("Someone"));
    });

    it("degrades a queued Slack item on queueChanged", () => {
      const projected = projectChatServerFrameForVersion(
        queueChangedFrame(slackPayload("Priya")),
        negotiated,
      );

      expect(queueMessageOf(asRecord(projected, "frame").queue)).toEqual(
        degraded("Priya"),
      );
      expect(
        chatSubscribeV142.serverFrameSchema.safeParse(projected).success,
      ).toBe(true);
    });

    it("degrades a range row", () => {
      const projected = projectChatServerFrameForVersion(
        rangeFrame(slackPayload("Priya")),
        negotiated,
      );

      const range = asRecord(asRecord(projected, "frame").range, "range");
      expect(firstMessageOf(range.messages)).toEqual(degraded("Priya"));
      expect(
        chatSubscribeV142.serverFrameSchema.safeParse(projected).success,
      ).toBe(true);
    });

    it("degrades a snapshot's tail and queue", () => {
      const projected = projectChatServerFrameForVersion(
        snapshotFrame(slackPayload("Priya"), slackPayload("Priya")),
        negotiated,
      );

      const snapshot = asRecord(
        asRecord(projected, "frame").snapshot,
        "snapshot",
      );
      expect(firstMessageOf(asRecord(snapshot.tail, "tail").messages)).toEqual(
        degraded("Priya"),
      );
      expect(queueMessageOf(snapshot.queue)).toEqual(degraded("Priya"));
      expect(
        chatSubscribeV142.serverFrameSchema.safeParse(projected).success,
      ).toBe(true);
    });

    describe.each(EVENT_CARRIERS)("on %s", (_carrier, frameOf) => {
      it.each(QUEUE_EVENTS)("degrades %s", (_event, eventOf) => {
        const projected = projectChatServerFrameForVersion(
          frameOf(eventOf()),
          negotiated,
        );

        expect(eventMessageOf(eventOfFrame(projected))).toEqual(
          degraded("Priya"),
        );
      });
    });

    it("does not touch the frame the caller passed in", () => {
      const frame = messageAcceptedFrame(slackPayload("Priya"));
      const before = structuredClone(frame);

      projectChatServerFrameForVersion(frame, negotiated);

      expect(frame).toEqual(before);
    });
  });

  it("passes the Slack message through unchanged on 1.43, which parses it", () => {
    const frames = [
      messageAcceptedFrame(slackPayload("Priya")),
      queueChangedFrame(slackPayload("Priya")),
      rangeFrame(slackPayload("Priya")),
      snapshotFrame(slackPayload("Priya"), slackPayload("Priya")),
    ];

    for (const frame of frames) {
      expect(projectChatServerFrameForVersion(frame, SLACK_AWARE)).toEqual(
        frame,
      );
      expect(chatSubscribeV143.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    }
  });

  it("rejects a Slack message on the 1.42 line unprojected, which is what the projection is for", () => {
    expect(
      chatSubscribeV142.serverFrameSchema.safeParse(
        messageAcceptedFrame(slackPayload("Priya")),
      ).success,
    ).toBe(false);
  });
});
