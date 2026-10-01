import { describe, expect, it } from "vitest";
import type {
  ChatEvent,
  ChatEventType,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  AUTO_JUDGE_NOTICE_MARKERS,
  autoJudgeNoticeRowSource,
  autoJudgeUnattendedDenialRowSource,
  compareCanonicalRowOrder,
  eventMaterializesTranscriptRow,
  importedChatMarkerRowSource,
  notificationAnchorRowSource,
  sortIntoCanonicalRowOrder,
  type CanonicalRowOrderKey,
} from "@traycer/protocol/persistence/chat-transcript/row-order";
import {
  autoJudgeNoticeRowId,
  isTurnDecoratingEvent,
  projectTranscriptRows,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * `row-order.ts` is the one definition the host (numbering rows) and the
 * renderer (drawing them) both trust. If it drifts, bodies render under the
 * wrong rows - see the module doc. These tests pin the properties that
 * matter, not the code shape.
 */

function makeChatEvent(fields: {
  eventId: string;
  type: ChatEventType;
  timestamp: number;
  message: string | null;
  metadata: Record<string, unknown> | null;
}): ChatEvent {
  return {
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: fields.message,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: fields.metadata,
  };
}

describe("compareCanonicalRowOrder", () => {
  it("sorts ascending by createdAt", () => {
    const rows: CanonicalRowOrderKey[] = [
      { createdAt: 30 },
      { createdAt: 10 },
      { createdAt: 20 },
    ];

    const sorted = [...rows].sort(compareCanonicalRowOrder);

    expect(sorted.map((row) => row.createdAt)).toEqual([10, 20, 30]);
  });

  it("keeps input order for ties, even when a plausible id tiebreak would reverse it", () => {
    // Every row shares createdAt=5. Ids are chosen so that sorting by id
    // ascending would produce the REVERSE of input order - if someone
    // "improves" the comparator with an id tiebreak, this assertion flips.
    const rows: Array<CanonicalRowOrderKey & { readonly id: string }> = [
      { id: "c", createdAt: 5 },
      { id: "b", createdAt: 5 },
      { id: "a", createdAt: 5 },
    ];

    const sorted = [...rows].sort(compareCanonicalRowOrder);

    expect(sorted.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });
});

describe("sortIntoCanonicalRowOrder", () => {
  it("does not mutate its input array", () => {
    const rows: ReadonlyArray<{
      readonly id: string;
      readonly createdAt: number;
    }> = [
      { id: "b", createdAt: 2 },
      { id: "a", createdAt: 1 },
    ];
    const original = [...rows];

    const sorted = sortIntoCanonicalRowOrder(rows, (row) => ({
      createdAt: row.createdAt,
    }));

    expect(rows).toEqual(original);
    expect(sorted.map((row) => row.id)).toEqual(["a", "b"]);
    expect(sorted).not.toBe(rows);
  });
});

describe("eventMaterializesTranscriptRow", () => {
  it("returns true for chat.forked with both sourceChatId and sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-1",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns false for chat.forked with metadata: null", () => {
    const event = makeChatEvent({
      eventId: "e-2",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: null,
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked missing sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-3",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked missing sourceChatId", () => {
    const event = makeChatEvent({
      eventId: "e-4",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with a non-string sourceChatId", () => {
    const event = makeChatEvent({
      eventId: "e-5",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: 42, sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with a non-string sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-6",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: 42 },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with an EMPTY-STRING sourceChatId", () => {
    // `renderableMetadataString` rejects `""` specifically, and the module doc
    // names `sourceChatId: ""` as the drift that put bodies under the wrong
    // rows. The suite covered missing keys and non-string values but never the
    // empty string, so the rule that exists for the documented failure was the
    // one rule with no test behind it.
    const event = makeChatEvent({
      eventId: "e-empty-chat",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "", sourceHostId: "host-1" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for chat.forked with an EMPTY-STRING sourceHostId", () => {
    const event = makeChatEvent({
      eventId: "e-empty-host",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: { sourceChatId: "chat-1", sourceHostId: "" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("normalizes an EMPTY-STRING send.failed code to null", () => {
    // The same empty-string rule on the other path it governs. Here `code` is
    // optional, so `""` does not withhold the row - it must simply not survive
    // as an empty code the renderer would draw a blank chip for.
    const event = makeChatEvent({
      eventId: "e-empty-code",
      type: "send.failed",
      timestamp: 1,
      message: "delivery failed",
      metadata: { notificationAnchor: true, code: "" },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(true);
    expect(notificationAnchorRowSource(event)?.code).toBeNull();
  });

  it("returns true for send.failed with a message and metadata.notificationAnchor === true", () => {
    const event = makeChatEvent({
      eventId: "e-7",
      type: "send.failed",
      timestamp: 1,
      message: "delivery failed",
      metadata: { notificationAnchor: true },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns false for send.failed with a message but no notificationAnchor", () => {
    const event = makeChatEvent({
      eventId: "e-8",
      type: "send.failed",
      timestamp: 1,
      message: "delivery failed",
      metadata: null,
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for send.failed with notificationAnchor: true but message: null", () => {
    const event = makeChatEvent({
      eventId: "e-9",
      type: "send.failed",
      timestamp: 1,
      message: null,
      metadata: { notificationAnchor: true },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns false for an unrelated event type", () => {
    const event = makeChatEvent({
      eventId: "e-10",
      type: "turn.started",
      timestamp: 1,
      message: "some message",
      metadata: {
        notificationAnchor: true,
        sourceChatId: "x",
        sourceHostId: "y",
      },
    });

    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });
});

describe("importedChatMarkerRowSource", () => {
  const wellFormed = {
    sourceProvider: "claude",
    nativeSessionId: "native-1",
    importedAt: 9_000,
    sourceCwd: "/repo",
  };

  it("returns the parsed provenance for a well-formed chat.imported, and the event materializes a row", () => {
    const event = makeChatEvent({
      eventId: "e-import",
      type: "chat.imported",
      timestamp: 9_000,
      message: null,
      metadata: wellFormed,
    });
    expect(importedChatMarkerRowSource(event)).toEqual(wellFormed);
    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns null for chat.imported with metadata: null", () => {
    const event = makeChatEvent({
      eventId: "e-import",
      type: "chat.imported",
      timestamp: 9_000,
      message: null,
      metadata: null,
    });
    expect(importedChatMarkerRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null when a required field is missing or empty - the renderer draws no row either", () => {
    for (const metadata of [
      { ...wellFormed, sourceCwd: "" },
      { ...wellFormed, importedAt: "yesterday" },
      { sourceProvider: "claude" },
    ]) {
      const event = makeChatEvent({
        eventId: "e-import",
        type: "chat.imported",
        timestamp: 9_000,
        message: null,
        metadata,
      });
      expect(importedChatMarkerRowSource(event)).toBeNull();
      expect(eventMaterializesTranscriptRow(event)).toBe(false);
    }
  });

  it("returns null for an unrelated event type carrying the same bag", () => {
    const event = makeChatEvent({
      eventId: "e-other",
      type: "chat.forked",
      timestamp: 9_000,
      message: null,
      metadata: wellFormed,
    });
    expect(importedChatMarkerRowSource(event)).toBeNull();
  });
});

describe("autoJudgeUnattendedDenialRowSource", () => {
  it("returns the rule and reason for an approval.denied with attendanceReason: agent-created", () => {
    const event = makeChatEvent({
      eventId: "e-denial",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: {
          attendanceReason: "agent-created",
          rule: "Force push",
          reason: "This rewrites remote history.",
        },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toEqual({
      rule: "Force push",
      reason: "This rewrites remote history.",
    });
    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns {rule: null, reason: null} when the journal recorded neither", () => {
    const event = makeChatEvent({
      eventId: "e-denial-bare",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: {
          attendanceReason: "agent-created",
          rule: null,
          reason: null,
        },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toEqual({
      rule: null,
      reason: null,
    });
    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns {rule: null, reason: null} when rule/reason are absent from the bag entirely", () => {
    const event = makeChatEvent({
      eventId: "e-denial-absent",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: { attendanceReason: "agent-created" },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toEqual({
      rule: null,
      reason: null,
    });
    expect(eventMaterializesTranscriptRow(event)).toBe(true);
  });

  it("returns null for an unrelated event type carrying the same metadata", () => {
    const event = makeChatEvent({
      eventId: "e-other-type",
      type: "chat.forked",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: {
          attendanceReason: "agent-created",
          rule: null,
          reason: null,
        },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null for approval.denied with metadata: null", () => {
    const event = makeChatEvent({
      eventId: "e-null-metadata",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: null,
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null for approval.denied with no autoJudge key at all", () => {
    const event = makeChatEvent({
      eventId: "e-no-autojudge",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {},
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null for attendanceReason: human-away-parked", () => {
    const event = makeChatEvent({
      eventId: "e-parked",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: {
          attendanceReason: "human-away-parked",
          rule: "Force push",
          reason: "This rewrites remote history.",
        },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null for attendanceReason: human-subscribed", () => {
    const event = makeChatEvent({
      eventId: "e-subscribed",
      type: "approval.denied",
      timestamp: 1,
      message: null,
      metadata: {
        autoJudge: {
          attendanceReason: "human-subscribed",
          rule: "Force push",
          reason: "This rewrites remote history.",
        },
      },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });

  it("returns null for an ordinary approval.denied with no attendance concept - every existing transcript's shape", () => {
    const event = makeChatEvent({
      eventId: "e-ordinary-denial",
      type: "approval.denied",
      timestamp: 1,
      message: "Denied by the user",
      metadata: { rule: "Force push" },
    });

    expect(autoJudgeUnattendedDenialRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });
});

/**
 * The host's three auto-mode judge notices, exactly as `emitAutoJudgeNotice`
 * writes them: a `permission.blocked` event whose `message` is the notice,
 * severity `warning`, and one of three `metadata.autoJudge` markers. `turnId`
 * and `messageId` are the active turn's when one is running and `null` when
 * none is, so both shapes are exercised.
 */
const AUTO_JUDGE_NOTICES = [
  [
    "fallback",
    "Traycer's judge couldn't run on Traycer inference (out of credits), so it is reviewing commands on Claude Code instead, billed to your account there.",
  ],
  [
    "unavailable",
    "Traycer could not resolve an auto-mode judge, so commands are being sent to you for approval. Pick a judge in Settings → Permissions.",
  ],
  [
    "policy-not-applied",
    "This repository's Auto mode rules can add restrictions but not permissions; only its Ask first and Never allow sections were applied.",
  ],
] as const;

function autoJudgeNoticeEvent(fields: {
  readonly eventId: string;
  readonly marker: unknown;
  readonly message: string | null;
  readonly turnId: string | null;
}): ChatEvent {
  return {
    eventId: fields.eventId,
    type: "permission.blocked",
    timestamp: 5,
    clientActionId: null,
    actor: null,
    message: fields.message,
    turnId: fields.turnId,
    messageId: fields.turnId === null ? null : "user-1",
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "warning",
    metadata: { autoJudge: fields.marker },
  };
}

describe("auto-judge notices (permission.blocked carrying metadata.autoJudge)", () => {
  it.each(AUTO_JUDGE_NOTICES)(
    "the %s notice draws a row of its own, in a turn or outside one",
    (marker, message) => {
      for (const turnId of ["turn-1", null]) {
        const event = autoJudgeNoticeEvent({
          eventId: `e-${marker}`,
          marker,
          message,
          turnId,
        });
        expect({
          materializes: eventMaterializesTranscriptRow(event),
          decorates: isTurnDecoratingEvent(event),
        }).toEqual({ materializes: true, decorates: false });
        expect(
          projectTranscriptRows({
            messages: [],
            events: [event],
            activeTurnId: null,
            chatId: "chat-1",
          }).map((row) => ({
            rowId: row.rowId,
            createdAt: row.createdAt,
            source: row.source,
          })),
        ).toEqual([
          {
            rowId: autoJudgeNoticeRowId(`e-${marker}`),
            createdAt: 5,
            source: { kind: "auto-judge-notice", eventId: `e-${marker}` },
          },
        ]);
        expect(autoJudgeNoticeRowSource(event)).toEqual({ marker, message });
      }
    },
  );

  it("covers exactly the markers the host writes", () => {
    expect(AUTO_JUDGE_NOTICE_MARKERS).toEqual([
      "unavailable",
      "policy-not-applied",
      "fallback",
    ]);
    expect(AUTO_JUDGE_NOTICES.map(([marker]) => marker).sort()).toEqual(
      [...AUTO_JUDGE_NOTICE_MARKERS].sort(),
    );
  });

  it("draws nothing for the older permission.blocked emitters, which carry no marker", () => {
    for (const metadata of [null, {}, { reason: "sandbox" }]) {
      const event: ChatEvent = {
        ...autoJudgeNoticeEvent({
          eventId: "e-old-blocked",
          marker: "fallback",
          message: "Blocked by the sandbox.",
          turnId: "turn-1",
        }),
        metadata,
      };
      expect(autoJudgeNoticeRowSource(event)).toBeNull();
      expect(eventMaterializesTranscriptRow(event)).toBe(false);
    }
  });

  it("draws nothing for a marker the host does not write, or one of another shape", () => {
    for (const marker of [
      "judge-fallback",
      "FALLBACK",
      "",
      null,
      { attendanceReason: "agent-created" },
    ]) {
      const event = autoJudgeNoticeEvent({
        eventId: "e-other-marker",
        marker,
        message: "Some notice.",
        turnId: null,
      });
      expect(autoJudgeNoticeRowSource(event)).toBeNull();
      expect(eventMaterializesTranscriptRow(event)).toBe(false);
    }
  });

  it("draws nothing when the notice has no text - the text is the row", () => {
    for (const message of [null, ""]) {
      const event = autoJudgeNoticeEvent({
        eventId: "e-no-text",
        marker: "fallback",
        message,
        turnId: "turn-1",
      });
      expect(autoJudgeNoticeRowSource(event)).toBeNull();
      expect(eventMaterializesTranscriptRow(event)).toBe(false);
    }
  });

  it("draws nothing for another event type carrying a notice marker", () => {
    const event: ChatEvent = {
      ...autoJudgeNoticeEvent({
        eventId: "e-denied-with-marker",
        marker: "fallback",
        message: "Denied.",
        turnId: null,
      }),
      type: "approval.denied",
    };
    expect(autoJudgeNoticeRowSource(event)).toBeNull();
    expect(eventMaterializesTranscriptRow(event)).toBe(false);
  });
});
