import {
  CHAT_SYNC_AUTO_JUDGE_NOTICE_READER_FLOOR,
  CHAT_SYNC_UNATTENDED_DENIAL_READER_FLOOR,
  chatSyncReaderFloorForTranscriptEvents,
  chatSyncReaderFloorForTranscriptMessages,
  gateChatHeadVersion,
} from "@traycer/protocol/persistence/chat-sync/head";
import type {
  ChatEvent,
  ChatEventType,
} from "@traycer/protocol/persistence/epic/chat-events";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import { describe, expect, it } from "vitest";

/**
 * A canvas annotation is a record shape a chat-sync reader below 1.10 cannot
 * hold: it has no `source` and requires the browser page fields and a crop.
 * Its publication therefore stamps a reader floor of 1.10, the minor that
 * introduced the canvas arm.
 *
 * A browser annotation does not. An older reader keeps parsing it from its
 * top-level page fields and ignores the `source` key it never declared, which
 * is why a record with no `source` (every one written before the canvas arm)
 * must not be floored either.
 */

const CANVAS_ANNOTATION_READER_FLOOR = { major: 1, minor: 10 };

const BROWSER_PAGE = {
  tabId: "t-1",
  sessionId: "s-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
} as const;

const COMMON_FIELDS = {
  kind: "browser-annotation",
  capturedAt: 1_700_000_000_000,
  comment: "Tighten this up",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  droppedElementCount: 0,
} as const;

/** A browser annotation as every release before the canvas arm wrote it. */
const OLD_BROWSER_ANNOTATION = {
  ...COMMON_FIELDS,
  annotationId: "ann-old-browser",
  ...BROWSER_PAGE,
  imageFileName: "browser-annotation-ann-old-browser.png",
  imageHash: "abc123def456",
};

const BROWSER_ANNOTATION = {
  ...OLD_BROWSER_ANNOTATION,
  annotationId: "ann-browser",
  source: { kind: "browser", ...BROWSER_PAGE },
};

const CANVAS_SOURCE = {
  kind: "canvas",
  artifactId: "artifact-1",
  boardPath: "boards/pricing.canvas",
  canvasPage: null,
  artifactTitle: "Pricing board",
} as const;

/** A canvas annotation with a crop. */
const CANVAS_ANNOTATION = {
  ...COMMON_FIELDS,
  annotationId: "ann-canvas",
  source: CANVAS_SOURCE,
  imageFileName: "browser-annotation-ann-canvas.png",
  imageHash: "0123456789abcdef",
};

/** A canvas annotation with no crop: the nullable image pair is both null. */
const NO_CROP_CANVAS_ANNOTATION = {
  ...CANVAS_ANNOTATION,
  annotationId: "ann-canvas-no-crop",
  imageFileName: null,
  imageHash: null,
};

function userRow(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    role: "user",
    messageId: "user-1",
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations,
    },
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
    blocks: [
      {
        type: "tool_call",
        blockId: "block-1",
        status: "completed",
        timestamp: 5,
        toolName: "traycer_render_inline",
      },
    ],
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

function agentAuthoredRow(): Record<string, unknown> {
  return {
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
    timestamp: 6,
    sessionAnchor: null,
  };
}

describe("chatSyncReaderFloorForTranscriptMessages", () => {
  it("floors a publication holding a canvas annotation at 1.10", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([userRow([CANVAS_ANNOTATION])]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it("floors a canvas annotation that carries no crop", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow([NO_CROP_CANVAS_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it("floors when the canvas annotation sits among browser ones, in either order", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow([BROWSER_ANNOTATION, CANVAS_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow([CANVAS_ANNOTATION, BROWSER_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it("floors when the canvas annotation is on a later message than ordinary ones", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        assistantRow(),
        userRow([]),
        userRow([BROWSER_ANNOTATION]),
        assistantRow(),
        userRow([NO_CROP_CANVAS_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it("does not floor a browser annotation that states its source", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([userRow([BROWSER_ANNOTATION])]),
    ).toBeNull();
  });

  it("does not floor an old browser annotation that has no source", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow([OLD_BROWSER_ANNOTATION]),
      ]),
    ).toBeNull();
  });

  it("does not floor rows of other kinds", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        assistantRow(),
        agentAuthoredRow(),
        userRow([]),
      ]),
    ).toBeNull();
    expect(chatSyncReaderFloorForTranscriptMessages([])).toBeNull();
  });

  it("does not floor an annotation whose source is some other kind", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow([{ ...CANVAS_ANNOTATION, source: { kind: "figma" } }]),
      ]),
    ).toBeNull();
  });

  it("ignores values that are not transcript rows", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        null,
        "text",
        42,
        [],
        {},
        { role: "user" },
        { role: "user", message: null },
        { role: "user", message: { kind: "user" } },
        { role: "user", message: { kind: "user", browserAnnotations: "no" } },
        { role: "user", message: { kind: "user", browserAnnotations: [null] } },
      ]),
    ).toBeNull();
  });

  it("walks any iterable, not only an array", () => {
    function* rows(): Generator<unknown> {
      yield assistantRow();
      yield userRow([CANVAS_ANNOTATION]);
    }
    expect(chatSyncReaderFloorForTranscriptMessages(rows())).toEqual(
      CANVAS_ANNOTATION_READER_FLOOR,
    );
  });

  it("names a floor gateChatHeadVersion honours at 1.10 and refuses at 1.9", () => {
    const floor = chatSyncReaderFloorForTranscriptMessages([
      userRow([CANVAS_ANNOTATION]),
    ]);
    if (floor === null) throw new Error("expected a floor");

    const head = {
      schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
      minReaderVersion: floor,
    };
    const refused = gateChatHeadVersion(head, { major: 1, minor: 9 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("reader-below-minimum");
    expect(gateChatHeadVersion(head, { major: 1, minor: 10 })).toEqual({
      ok: true,
    });
  });

  it("is pinned at 1.10 and cannot exceed the schema version that introduced it", () => {
    expect(CHAT_SYNC_SCHEMA_VERSION.major).toBe(1);
    expect(CHAT_SYNC_SCHEMA_VERSION.minor).toBeGreaterThanOrEqual(
      CANVAS_ANNOTATION_READER_FLOOR.minor,
    );
  });
});

/**
 * A queue event embeds the whole prompt item under untyped metadata: `item` on
 * `queue.added`, `items` on `queue.paused` / `queue.reordered`. A canvas
 * annotation on a queued prompt is therefore in the publication's events
 * before any message row holds it, so the event floor must see it too.
 */

function chatEvent(
  eventId: string,
  type: ChatEventType,
  metadata: Record<string, unknown> | null,
): ChatEvent {
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

function queuedPrompt(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "user-1",
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations,
    },
  };
}

function queueAddedEvent(
  browserAnnotations: ReadonlyArray<unknown>,
): ChatEvent {
  return chatEvent("e-added", "queue.added", {
    item: queuedPrompt(browserAnnotations),
  });
}

function queueItemsEvent(
  type: "queue.paused" | "queue.reordered",
  items: ReadonlyArray<unknown>,
): ChatEvent {
  return chatEvent(`e-${type}`, type, { items });
}

function ordinaryEvent(): ChatEvent {
  return chatEvent("e-ordinary", "turn.started", null);
}

/** The judge notice: the row with the higher of the two pre-existing floors. */
function judgeFallbackNoticeEvent(): ChatEvent {
  return {
    ...chatEvent("e-notice", "permission.blocked", { autoJudge: "fallback" }),
    message:
      "Traycer's judge couldn't run on Traycer inference (out of credits), so it is reviewing commands on Claude Code instead, billed to your account there.",
    severity: "warning",
  };
}

function unattendedDenialEvent(): ChatEvent {
  return chatEvent("e-denial", "approval.denied", {
    autoJudge: {
      attendanceReason: "agent-created",
      rule: "no-secrets",
      reason: "matched a secret pattern",
    },
  });
}

describe("chatSyncReaderFloorForTranscriptEvents and queued canvas annotations", () => {
  it("floors a queue.added event whose metadata.item carries a canvas annotation", () => {
    expect(
      chatSyncReaderFloorForTranscriptEvents([
        queueAddedEvent([CANVAS_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it("floors a queued canvas annotation that carries no crop", () => {
    expect(
      chatSyncReaderFloorForTranscriptEvents([
        queueAddedEvent([NO_CROP_CANVAS_ANNOTATION]),
      ]),
    ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
  });

  it.each(["queue.paused", "queue.reordered"] as const)(
    "floors a %s event whose metadata.items holds a canvas prompt",
    (type) => {
      expect(
        chatSyncReaderFloorForTranscriptEvents([
          queueItemsEvent(type, [
            queuedPrompt([BROWSER_ANNOTATION]),
            queuedPrompt([BROWSER_ANNOTATION, CANVAS_ANNOTATION]),
          ]),
        ]),
      ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
    },
  );

  it("does not floor queued browser annotations, with or without a source", () => {
    expect(
      chatSyncReaderFloorForTranscriptEvents([
        queueAddedEvent([BROWSER_ANNOTATION, OLD_BROWSER_ANNOTATION]),
        queueItemsEvent("queue.paused", [
          queuedPrompt([OLD_BROWSER_ANNOTATION]),
        ]),
      ]),
    ).toBeNull();
  });

  it("ignores queue metadata that is not a prompt item with annotations", () => {
    expect(
      chatSyncReaderFloorForTranscriptEvents([
        chatEvent("e-1", "queue.added", null),
        chatEvent("e-2", "queue.added", { item: null }),
        chatEvent("e-3", "queue.added", { item: "text" }),
        chatEvent("e-4", "queue.added", {
          item: { kind: "managed-command", queueItemId: "queue-2" },
        }),
        chatEvent("e-5", "queue.paused", { items: "no" }),
        chatEvent("e-6", "queue.paused", { items: [null, 3, {}] }),
        chatEvent("e-7", "queue.reordered", {
          items: [{ kind: "prompt", message: { kind: "agent" } }],
        }),
        chatEvent("e-8", "queue.added", {
          item: {
            kind: "prompt",
            message: { kind: "user", browserAnnotations: "no" },
          },
        }),
      ]),
    ).toBeNull();
  });

  describe("beside the rows with a lower floor", () => {
    const queued = queueAddedEvent([CANVAS_ANNOTATION]);

    it.each([
      ["a judge notice", judgeFallbackNoticeEvent()],
      ["an unattended denial", unattendedDenialEvent()],
    ])(
      "returns 1.10, not the lower floor, with %s before the queue event",
      (_label, lower) => {
        expect(
          chatSyncReaderFloorForTranscriptEvents([
            ordinaryEvent(),
            lower,
            queued,
          ]),
        ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
      },
    );

    it.each([
      ["a judge notice", judgeFallbackNoticeEvent()],
      ["an unattended denial", unattendedDenialEvent()],
    ])("returns 1.10 with %s after the queue event", (_label, lower) => {
      expect(
        chatSyncReaderFloorForTranscriptEvents([
          queued,
          ordinaryEvent(),
          lower,
        ]),
      ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
    });

    it("does not let a notice's early return hide a later queue event", () => {
      expect(
        chatSyncReaderFloorForTranscriptEvents([
          judgeFallbackNoticeEvent(),
          ordinaryEvent(),
          queueItemsEvent("queue.paused", [queuedPrompt([CANVAS_ANNOTATION])]),
        ]),
      ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
    });

    it("keeps the lower floor when the queue holds only browser annotations", () => {
      const browserOnly = queueAddedEvent([BROWSER_ANNOTATION]);
      expect(
        chatSyncReaderFloorForTranscriptEvents([
          browserOnly,
          judgeFallbackNoticeEvent(),
        ]),
      ).toEqual(CHAT_SYNC_AUTO_JUDGE_NOTICE_READER_FLOOR);
      expect(
        chatSyncReaderFloorForTranscriptEvents([
          unattendedDenialEvent(),
          browserOnly,
        ]),
      ).toEqual(CHAT_SYNC_UNATTENDED_DENIAL_READER_FLOOR);
    });

    it("is the higher of the three with a notice, a denial and a queue event in any order", () => {
      const events = [
        judgeFallbackNoticeEvent(),
        unattendedDenialEvent(),
        queued,
      ];
      const orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      for (const order of orders) {
        expect(
          chatSyncReaderFloorForTranscriptEvents(order.map((i) => events[i])),
        ).toEqual(CANVAS_ANNOTATION_READER_FLOOR);
      }
    });
  });
});
