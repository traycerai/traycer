import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatSubscribeClientFrameSchema,
  type ChatSubscribeClientFrame,
  chatSubscribeV129,
  chatSubscribeV130,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `chat.subscribe@1.30` lets a browser annotation record name a canvas
 * artifact as its source, with no crop and with elements that carry their
 * place in the artifact's source (`sourceRange`, `tid`, `textRange`).
 *
 * PROJECTION, not tolerance. Every line from `1.7` to `1.29` binds the frozen
 * browser-only record, which requires `tabId`, `sessionId`, `origin`,
 * `pageUrl`, `pageTitle`, a non-null crop and has no `source`. A canvas record
 * cannot be expressed there at all, so the projector drops it rather than
 * strip it into a half-record, and a browser record loses the `source` and
 * element keys that line never declared. `1.30` sees every record untouched.
 *
 * Lines below `1.7` already lose the whole `browserAnnotations` key; that
 * older cliff is pinned by `chat-frame-compat.test.ts` and only checked here
 * to prove the new projection did not move it.
 */

const CANVAS_AWARE: SchemaVersion = { major: 1, minor: 30 };
const DOWNGRADED_MINORS = [7, 12, 22, 28, 29] as const;

const BROWSER_PAGE = {
  tabId: "t-1",
  sessionId: "s-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
} as const;

const BASE_ELEMENT = {
  selector: "main > h1",
  tagName: "h1",
  elementId: null,
  classNames: ["hero"],
  textPreview: "Example Domain",
  ariaRole: "heading",
  accessibleName: "Example Domain",
  boundingBox: {
    x: 60,
    y: 90,
    width: 420,
    height: 40,
    top: 90,
    right: 480,
    bottom: 130,
    left: 60,
  },
  computedStyles: [{ property: "font-size", value: "26px" }],
};

/** The browser record as every line up to `1.29` declares it. */
const FROZEN_BROWSER_RECORD = {
  kind: "browser-annotation" as const,
  annotationId: "ann-browser",
  ...BROWSER_PAGE,
  capturedAt: 1_700_000_000_000,
  comment: "Make this hero section pop more",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [BASE_ELEMENT],
  imageFileName: "browser-annotation-ann-browser.png",
  imageHash: "abc123def456",
  droppedElementCount: 0,
};

/** The same record as a `1.30` peer carries it: `source` is present. */
const LIVE_BROWSER_RECORD = {
  ...FROZEN_BROWSER_RECORD,
  source: { kind: "browser" as const, ...BROWSER_PAGE },
};

const CANVAS_ELEMENT = {
  ...BASE_ELEMENT,
  sourceRange: { start: 120, end: 168, line: 7 },
  tid: "t-heading-1",
  textRange: { start: 124, end: 131, quote: "Pricing" },
};

const CANVAS_RECORD = {
  kind: "browser-annotation" as const,
  annotationId: "ann-canvas",
  source: {
    kind: "canvas" as const,
    artifactId: "artifact-1",
    boardPath: "boards/pricing.canvas",
    canvasPage: null,
    artifactTitle: "Pricing board",
  },
  capturedAt: 1_700_000_000_500,
  comment: "Tighten the spacing under this heading",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [CANVAS_ELEMENT],
  imageFileName: null,
  imageHash: null,
  droppedElementCount: 0,
};

/**
 * A browser-arm record whose element somehow carries the canvas-only keys. A
 * released peer's frozen element does not declare them, so they must not reach
 * it whichever arm the record claims to be.
 */
const LIVE_BROWSER_RECORD_WITH_CANVAS_ELEMENT_KEYS = {
  ...LIVE_BROWSER_RECORD,
  annotationId: "ann-browser-stray-keys",
  elements: [CANVAS_ELEMENT],
};

function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return value;
}

function asArray(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new Error(`expected array for ${label}`);
  }
  return value;
}

function annotationsOf(payload: unknown): ReadonlyArray<unknown> {
  return asArray(
    asRecord(payload, "payload").browserAnnotations,
    "annotations",
  );
}

function userPayload(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    kind: "user",
    content: { type: "doc", content: [] },
    browserAnnotations,
  };
}

function userRow(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    role: "user",
    messageId: "user-1",
    sender: { type: "user", userId: "user-1" },
    message: userPayload(browserAnnotations),
    timestamp: 5,
    sessionAnchor: null,
  };
}

function assistantRow(): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: 1,
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/** The user-authored payload carried by one transcript row. */
function payloadOf(row: unknown): Record<string, unknown> {
  return asRecord(asRecord(row, "row").message, "row payload");
}

function frameMessageAnnotations(frame: unknown): ReadonlyArray<unknown> {
  return annotationsOf(payloadOf(asRecord(frame, "frame").message));
}

function promptQueueItem(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "user-1",
    message: userPayload(browserAnnotations),
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
  };
}

function queueOf(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    status: "idle",
    items: [promptQueueItem(browserAnnotations)],
  };
}

function queueItemAnnotations(queue: unknown): ReadonlyArray<unknown> {
  const items = asArray(asRecord(queue, "queue").items, "queue items");
  return annotationsOf(asRecord(items[0], "queue item").message);
}

function serverFrame(
  body: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  const kind = body.kind;
  if (typeof kind !== "string") {
    throw new Error("expected frame kind");
  }
  return {
    ...body,
    kind,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
  };
}

function messageAcceptedFrame(
  annotations: ReadonlyArray<unknown>,
): ProjectedChatSubscribeServerFrame {
  return serverFrame({
    kind: "messageAccepted",
    message: userRow(annotations),
  });
}

function queueChangedFrame(
  annotations: ReadonlyArray<unknown>,
): ProjectedChatSubscribeServerFrame {
  return serverFrame({ kind: "queueChanged", queue: queueOf(annotations) });
}

function rangeFrame(
  annotations: ReadonlyArray<unknown>,
): ProjectedChatSubscribeServerFrame {
  return serverFrame({
    kind: "range",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["user-1", "assistant-1"],
      messages: [userRow(annotations), assistantRow()],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

function snapshotFrame(
  annotations: ReadonlyArray<unknown>,
  queueAnnotations: ReadonlyArray<unknown>,
): ProjectedChatSubscribeServerFrame {
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
      queue: queueOf(queueAnnotations),
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 2,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        messages: [userRow(annotations), assistantRow()],
        events: [],
      },
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

function snapshotTailAnnotations(frame: unknown): ReadonlyArray<unknown> {
  const snapshot = asRecord(asRecord(frame, "frame").snapshot, "snapshot");
  const tail = asRecord(snapshot.tail, "tail");
  return annotationsOf(payloadOf(asArray(tail.messages, "tail")[0]));
}

function rangeAnnotations(frame: unknown): ReadonlyArray<unknown> {
  const range = asRecord(asRecord(frame, "frame").range, "range");
  return annotationsOf(payloadOf(asArray(range.messages, "range")[0]));
}

function liveSendFrame(
  annotations: ReadonlyArray<unknown>,
): ChatSubscribeClientFrame {
  return chatSubscribeClientFrameSchema.parse({
    kind: "send",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    messageId: "message-1",
    content: { type: "doc", content: [] },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5.4",
      permissionMode: "supervised",
      reasoningEffort: "high",
      agentMode: "epic",
    },
    accountContext: { type: "PERSONAL" },
    browserAnnotations: annotations,
  });
}

describe("chat.subscribe client send frame projection", () => {
  describe.each(DOWNGRADED_MINORS)("to chat.subscribe@1.%i", (minor) => {
    it("drops a canvas annotation and keeps the browser one in order", () => {
      const frame = liveSendFrame([
        CANVAS_RECORD,
        LIVE_BROWSER_RECORD,
        CANVAS_RECORD,
      ]);

      const projected = projectChatClientFrameForVersion(frame, version(minor));

      expect(annotationsOf(projected)).toEqual([FROZEN_BROWSER_RECORD]);
    });

    it("removes the `source` key off a browser annotation", () => {
      const projected = projectChatClientFrameForVersion(
        liveSendFrame([LIVE_BROWSER_RECORD]),
        version(minor),
      );

      const [annotation] = annotationsOf(projected);
      expect(annotation).toEqual(FROZEN_BROWSER_RECORD);
      expect(Object.hasOwn(asRecord(annotation, "annotation"), "source")).toBe(
        false,
      );
    });

    it("sends an empty list, not a missing key, when only canvas annotations were attached", () => {
      const projected = projectChatClientFrameForVersion(
        liveSendFrame([CANVAS_RECORD]),
        version(minor),
      );

      expect(Object.hasOwn(projected, "browserAnnotations")).toBe(true);
      expect(annotationsOf(projected)).toEqual([]);
    });

    it("produces a frame the frozen line parses to the same annotations", () => {
      const projected = projectChatClientFrameForVersion(
        liveSendFrame([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
        version(minor),
      );

      const parsed = chatSubscribeV129.clientFrameSchema.parse(projected);
      if (parsed.kind !== "send") {
        throw new Error("expected send frame");
      }
      expect(parsed.browserAnnotations).toEqual([FROZEN_BROWSER_RECORD]);
    });

    it("does not touch the frame the caller passed in", () => {
      const frame = liveSendFrame([CANVAS_RECORD, LIVE_BROWSER_RECORD]);
      const before = structuredClone(frame);

      projectChatClientFrameForVersion(frame, version(minor));

      expect(frame).toEqual(before);
    });
  });

  it("leaves a frame with no annotations as it was", () => {
    const frame = liveSendFrame([]);

    const projected = projectChatClientFrameForVersion(frame, version(29));

    expect(annotationsOf(projected)).toEqual([]);
  });

  it("preserves both arms on the latest line", () => {
    const frame = liveSendFrame([LIVE_BROWSER_RECORD, CANVAS_RECORD]);

    const projected = projectChatClientFrameForVersion(frame, CANVAS_AWARE);

    expect(annotationsOf(projected)).toEqual([
      LIVE_BROWSER_RECORD,
      CANVAS_RECORD,
    ]);
    const parsed = chatSubscribeV130.clientFrameSchema.parse(projected);
    if (parsed.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(parsed.browserAnnotations).toEqual([
      LIVE_BROWSER_RECORD,
      CANVAS_RECORD,
    ]);
  });

  it("still drops the whole key below 1.7, as before the canvas arm", () => {
    const projected = projectChatClientFrameForVersion(
      liveSendFrame([LIVE_BROWSER_RECORD, CANVAS_RECORD]),
      version(6),
    );

    expect(Object.hasOwn(projected, "browserAnnotations")).toBe(false);
  });
});

describe("chat.subscribe server frame projection", () => {
  describe.each(DOWNGRADED_MINORS)("to chat.subscribe@1.%i", (minor) => {
    const negotiated = version(minor);

    it("drops canvas annotations and the browser `source` on messageAccepted", () => {
      const projected = projectChatServerFrameForVersion(
        messageAcceptedFrame([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
        negotiated,
      );

      expect(frameMessageAnnotations(projected)).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      const parsed = chatSubscribeV129.serverFrameSchema.safeParse(projected);
      expect(parsed.success).toBe(true);
    });

    it("drops canvas annotations and the browser `source` on a snapshot's tail and queue", () => {
      const projected = projectChatServerFrameForVersion(
        snapshotFrame(
          [LIVE_BROWSER_RECORD, CANVAS_RECORD],
          [CANVAS_RECORD, LIVE_BROWSER_RECORD],
        ),
        negotiated,
      );

      expect(snapshotTailAnnotations(projected)).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      const snapshot = asRecord(
        asRecord(projected, "projected").snapshot,
        "snapshot",
      );
      expect(queueItemAnnotations(snapshot.queue)).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
    });

    it("leaves the rows around a user row on a snapshot's tail alone", () => {
      const frame = snapshotFrame([CANVAS_RECORD], []);
      const original = asRecord(
        asRecord(asRecord(frame, "frame").snapshot, "snapshot").tail,
        "tail",
      );
      const originalAssistant = asArray(original.messages, "tail")[1];

      const projected = projectChatServerFrameForVersion(frame, negotiated);

      const tail = asRecord(
        asRecord(asRecord(projected, "projected").snapshot, "snapshot").tail,
        "tail",
      );
      expect(asArray(tail.messages, "tail")[1]).toEqual(originalAssistant);
      expect(asArray(tail.messages, "tail")).toHaveLength(2);
    });

    it("drops canvas annotations and the browser `source` on a range row", () => {
      const projected = projectChatServerFrameForVersion(
        rangeFrame([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
        negotiated,
      );

      expect(rangeAnnotations(projected)).toEqual([FROZEN_BROWSER_RECORD]);
    });

    it("drops canvas annotations and the browser `source` on queueChanged prompt items", () => {
      const projected = projectChatServerFrameForVersion(
        queueChangedFrame([LIVE_BROWSER_RECORD, CANVAS_RECORD]),
        negotiated,
      );

      expect(
        queueItemAnnotations(asRecord(projected, "projected").queue),
      ).toEqual([FROZEN_BROWSER_RECORD]);
    });

    it("keeps an empty list, not a missing key, when only canvas annotations were attached", () => {
      const projected = projectChatServerFrameForVersion(
        messageAcceptedFrame([CANVAS_RECORD]),
        negotiated,
      );

      expect(frameMessageAnnotations(projected)).toEqual([]);
    });

    it("removes the canvas-only element keys wherever a record carries them", () => {
      const projected = projectChatServerFrameForVersion(
        messageAcceptedFrame([LIVE_BROWSER_RECORD_WITH_CANVAS_ELEMENT_KEYS]),
        negotiated,
      );

      const [annotation] = frameMessageAnnotations(projected);
      const [element] = asArray(
        asRecord(annotation, "annotation").elements,
        "elements",
      );
      expect(element).toEqual(BASE_ELEMENT);
      for (const key of ["sourceRange", "tid", "textRange"]) {
        expect(Object.hasOwn(asRecord(element, "element"), key)).toBe(false);
      }
    });

    it("does not touch the frame the caller passed in", () => {
      const frame = messageAcceptedFrame([CANVAS_RECORD, LIVE_BROWSER_RECORD]);
      const before = structuredClone(frame);

      projectChatServerFrameForVersion(frame, negotiated);

      expect(frame).toEqual(before);
    });
  });

  it("preserves both arms, with every element key, on the latest line", () => {
    const annotations = [LIVE_BROWSER_RECORD, CANVAS_RECORD];
    const frames = [
      messageAcceptedFrame(annotations),
      queueChangedFrame(annotations),
      rangeFrame(annotations),
      snapshotFrame(annotations, annotations),
    ];

    for (const frame of frames) {
      expect(projectChatServerFrameForVersion(frame, CANVAS_AWARE)).toEqual(
        frame,
      );
    }
  });

  it("accepts the unprojected frames on the latest line", () => {
    const annotations = [LIVE_BROWSER_RECORD, CANVAS_RECORD];
    const frames = [
      messageAcceptedFrame(annotations),
      rangeFrame(annotations),
      snapshotFrame(annotations, []),
    ];

    for (const frame of frames) {
      expect(chatSubscribeV130.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    }
  });

  it("leaves a user row with no annotations alone on every downgraded line", () => {
    for (const minor of DOWNGRADED_MINORS) {
      const frame = messageAcceptedFrame([]);

      const projected = projectChatServerFrameForVersion(frame, version(minor));

      expect(frameMessageAnnotations(projected)).toEqual([]);
    }
  });

  it("does not turn an agent-authored message into a user-authored one", () => {
    const frame = serverFrame({
      kind: "messageAccepted",
      message: {
        role: "user",
        messageId: "user-2",
        sender: {
          type: "agent",
          harnessId: "claude",
          agentId: "agent-1",
          displayName: "Coder",
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        message: { kind: "agent", content: { type: "doc", content: [] } },
        timestamp: 5,
        sessionAnchor: null,
      },
    });

    const projected = projectChatServerFrameForVersion(frame, version(29));

    expect(
      Object.hasOwn(
        payloadOf(asRecord(projected, "projected").message),
        "browserAnnotations",
      ),
    ).toBe(false);
  });
});

/**
 * Queue events re-embed the whole prompt item under untyped metadata: `item`
 * on `queue.added`, `items` on `queue.paused` / `queue.reordered`. The queue
 * and transcript strips never reach it, so a peer below `1.30` would read a
 * canvas record out of the event channel unless the projector walks the same
 * metadata. The event rides four carriers: `eventAppended`, a snapshot's
 * `tail.events`, a range's `events`, and - on the whole-snapshot shape - the
 * snapshot's `chat.events`.
 */

function chatEvent(
  eventId: string,
  type: string,
  metadata: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    eventId,
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

function queueAddedEvent(
  annotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return chatEvent("e-added", "queue.added", {
    item: promptQueueItem(annotations),
  });
}

function queueItemsEvent(
  type: "queue.paused" | "queue.reordered",
  items: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return chatEvent(`e-${type}`, type, { items });
}

function eventAppendedFrame(
  event: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  return serverFrame({ kind: "eventAppended", event });
}

function eventItem(event: unknown): Record<string, unknown> {
  const metadata = asRecord(asRecord(event, "event").metadata, "metadata");
  return asRecord(metadata.item, "metadata.item");
}

function eventItems(event: unknown): ReadonlyArray<unknown> {
  const metadata = asRecord(asRecord(event, "event").metadata, "metadata");
  return asArray(metadata.items, "metadata.items");
}

function itemAnnotations(item: unknown): ReadonlyArray<unknown> {
  return annotationsOf(asRecord(item, "queue item").message);
}

/** A windowed snapshot whose tail carries the given events. */
function snapshotFrameWithTailEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): ProjectedChatSubscribeServerFrame {
  const frame = snapshotFrame([], []);
  const snapshot = asRecord(frame.snapshot, "snapshot");
  const tail = asRecord(snapshot.tail, "tail");
  return {
    ...frame,
    snapshot: { ...snapshot, tail: { ...tail, events } },
  };
}

function rangeFrameWithEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): ProjectedChatSubscribeServerFrame {
  const frame = rangeFrame([]);
  const range = asRecord(frame.range, "range");
  return { ...frame, range: { ...range, events } };
}

/** The whole-snapshot shape: the transcript and events sit under `chat`. */
function legacyWholeSnapshotFrame(
  events: ReadonlyArray<Record<string, unknown>>,
): ProjectedChatSubscribeServerFrame {
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
        messages: [
          userRow([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
          assistantRow(),
        ],
        events,
      },
      queue: queueOf([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
      runStatus: "idle",
    },
  });
}

function snapshotChatEvents(frame: unknown): ReadonlyArray<unknown> {
  const snapshot = asRecord(asRecord(frame, "frame").snapshot, "snapshot");
  return asArray(asRecord(snapshot.chat, "chat").events, "chat events");
}

function tailEvents(frame: unknown): ReadonlyArray<unknown> {
  const snapshot = asRecord(asRecord(frame, "frame").snapshot, "snapshot");
  return asArray(asRecord(snapshot.tail, "tail").events, "tail events");
}

function rangeEvents(frame: unknown): ReadonlyArray<unknown> {
  const range = asRecord(asRecord(frame, "frame").range, "range");
  return asArray(range.events, "range events");
}

describe("chat.subscribe queue event metadata projection", () => {
  describe.each(DOWNGRADED_MINORS)("to chat.subscribe@1.%i", (minor) => {
    const negotiated = version(minor);

    it("drops canvas annotations and the browser `source` from queue.added's metadata.item", () => {
      const projected = projectChatServerFrameForVersion(
        eventAppendedFrame(
          queueAddedEvent([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
        ),
        negotiated,
      );

      const event = asRecord(projected, "projected").event;
      expect(itemAnnotations(eventItem(event))).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
    });

    it.each(["queue.paused", "queue.reordered"] as const)(
      "drops canvas annotations and the browser `source` from %s's metadata.items",
      (type) => {
        const projected = projectChatServerFrameForVersion(
          eventAppendedFrame(
            queueItemsEvent(type, [
              promptQueueItem([LIVE_BROWSER_RECORD, CANVAS_RECORD]),
              promptQueueItem([CANVAS_RECORD]),
            ]),
          ),
          negotiated,
        );

        const items = eventItems(asRecord(projected, "projected").event);
        expect(items.map(itemAnnotations)).toEqual([
          [FROZEN_BROWSER_RECORD],
          [],
        ]);
      },
    );

    it("leaves the rest of the queue item, and other metadata keys, as they were", () => {
      const event = queueAddedEvent([CANVAS_RECORD]);
      const withExtra = {
        ...event,
        metadata: { ...asRecord(event.metadata, "metadata"), reason: "x" },
      };

      const projected = projectChatServerFrameForVersion(
        eventAppendedFrame(withExtra),
        negotiated,
      );

      const projectedEvent = asRecord(
        asRecord(projected, "projected").event,
        "event",
      );
      expect(asRecord(projectedEvent.metadata, "metadata").reason).toBe("x");
      const item = eventItem(projectedEvent);
      const original = promptQueueItem([]);
      expect(item.queueItemId).toBe(original.queueItemId);
      expect(item.settings).toEqual(original.settings);
      expect(item.kind).toBe("prompt");
    });

    it("leaves an event with no queue metadata untouched", () => {
      const frame = eventAppendedFrame(
        chatEvent("e-plain", "turn.started", null),
      );

      const projected = projectChatServerFrameForVersion(frame, negotiated);

      expect(asRecord(projected, "projected").event).toEqual(
        chatEvent("e-plain", "turn.started", null),
      );
    });

    it("projects events on a snapshot's tail", () => {
      const projected = projectChatServerFrameForVersion(
        snapshotFrameWithTailEvents([
          queueAddedEvent([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
          queueItemsEvent("queue.paused", [promptQueueItem([CANVAS_RECORD])]),
        ]),
        negotiated,
      );

      const [added, paused] = tailEvents(projected);
      expect(itemAnnotations(eventItem(added))).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      expect(eventItems(paused).map(itemAnnotations)).toEqual([[]]);
    });

    it("projects events on a range response", () => {
      const projected = projectChatServerFrameForVersion(
        rangeFrameWithEvents([
          queueAddedEvent([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
          queueItemsEvent("queue.reordered", [
            promptQueueItem([LIVE_BROWSER_RECORD]),
          ]),
        ]),
        negotiated,
      );

      const [added, reordered] = rangeEvents(projected);
      expect(itemAnnotations(eventItem(added))).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      expect(eventItems(reordered).map(itemAnnotations)).toEqual([
        [FROZEN_BROWSER_RECORD],
      ]);
    });

    it("projects a whole snapshot: its messages, queue and chat events together", () => {
      const projected = projectChatServerFrameForVersion(
        legacyWholeSnapshotFrame([
          queueAddedEvent([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
          queueItemsEvent("queue.paused", [
            promptQueueItem([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
          ]),
        ]),
        negotiated,
      );

      const snapshot = asRecord(
        asRecord(projected, "projected").snapshot,
        "snapshot",
      );
      const chat = asRecord(snapshot.chat, "chat");
      const messages = asArray(chat.messages, "messages");
      expect(annotationsOf(payloadOf(messages[0]))).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      expect(queueItemAnnotations(snapshot.queue)).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      const [added, paused] = snapshotChatEvents(projected);
      expect(itemAnnotations(eventItem(added))).toEqual([
        FROZEN_BROWSER_RECORD,
      ]);
      expect(eventItems(paused).map(itemAnnotations)).toEqual([
        [FROZEN_BROWSER_RECORD],
      ]);
    });

    it("does not touch the frame the caller passed in", () => {
      const frame = legacyWholeSnapshotFrame([
        queueAddedEvent([CANVAS_RECORD, LIVE_BROWSER_RECORD]),
      ]);
      const before = structuredClone(frame);

      projectChatServerFrameForVersion(frame, negotiated);

      expect(frame).toEqual(before);
    });
  });

  it("preserves queue event metadata, canvas records included, on the latest line", () => {
    const annotations = [LIVE_BROWSER_RECORD, CANVAS_RECORD];
    const events = [
      queueAddedEvent(annotations),
      queueItemsEvent("queue.paused", [promptQueueItem(annotations)]),
    ];
    const frames = [
      eventAppendedFrame(events[0]),
      snapshotFrameWithTailEvents(events),
      rangeFrameWithEvents(events),
      legacyWholeSnapshotFrame(events),
    ];

    for (const frame of frames) {
      expect(projectChatServerFrameForVersion(frame, CANVAS_AWARE)).toEqual(
        frame,
      );
    }
  });
});
