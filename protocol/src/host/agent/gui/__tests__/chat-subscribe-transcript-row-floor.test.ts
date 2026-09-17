import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  minimumChatSubscribeMinorForTranscriptEvent,
  supportsAutoPermissionMode,
  supportsTranscriptRowsFor,
} from "../chat-frame-compat";

/**
 * `minimumChatSubscribeMinorForTranscriptEvent` and `supportsTranscriptRowsFor`
 * are the transcript-row half of the `1.11` floor: the durable
 * `auto-judge-unattended-denial` row survives a chat's `permissionMode`
 * switching back out of Auto, because it is folded from `chat.events` rather
 * than read off `chat.settings`. See the doc on
 * `minimumChatSubscribeMinorForTranscriptEvent` in `chat-frame-compat.ts`.
 */

function makeChatEvent(fields: {
  eventId: string;
  type: ChatEvent["type"];
  metadata: Record<string, unknown> | null;
}): ChatEvent {
  return {
    eventId: fields.eventId,
    type: fields.type,
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
    metadata: fields.metadata,
  };
}

const AUTO_JUDGE_UNATTENDED_DENIAL_EVENT = makeChatEvent({
  eventId: "e-denial",
  type: "approval.denied",
  metadata: {
    autoJudge: {
      attendanceReason: "agent-created",
      rule: "Force push",
      reason: "This rewrites remote history.",
    },
  },
});

const ORDINARY_APPROVAL_DENIED_EVENT = makeChatEvent({
  eventId: "e-ordinary-denial",
  type: "approval.denied",
  metadata: null,
});

const UNRELATED_EVENT = makeChatEvent({
  eventId: "e-unrelated",
  type: "history.deleted",
  metadata: { fromMessageId: "m-1" },
});

/**
 * Derives the transcript-row floor from `supportsAutoPermissionMode`'s own
 * observable cliff rather than restating the "11" literal: the row's floor
 * and the client-frame auto-mode floor are the same minor
 * (`CHAT_SUBSCRIBE_AUTO_MODE_MINOR`) by construction, so the smallest minor at
 * which that predicate turns true IS the floor this suite checks against.
 */
function smallestMinorWhereAutoPermissionModeIsSupported(): number {
  for (let minor = 0; minor <= 50; minor += 1) {
    if (supportsAutoPermissionMode({ major: 1, minor })) return minor;
  }
  throw new Error(
    "supportsAutoPermissionMode never turned true within the scanned range",
  );
}

const TRANSCRIPT_ROW_FLOOR = smallestMinorWhereAutoPermissionModeIsSupported();

describe("minimumChatSubscribeMinorForTranscriptEvent", () => {
  it("floors an approval.denied carrying auto-judge unattended-denial metadata at the auto-mode minor", () => {
    expect(
      minimumChatSubscribeMinorForTranscriptEvent(
        AUTO_JUDGE_UNATTENDED_DENIAL_EVENT,
      ),
    ).toBe(TRANSCRIPT_ROW_FLOOR);
  });

  it("returns 0 for an approval.denied without the unattended-denial metadata", () => {
    expect(
      minimumChatSubscribeMinorForTranscriptEvent(
        ORDINARY_APPROVAL_DENIED_EVENT,
      ),
    ).toBe(0);
  });

  it("returns 0 for an unrelated event type", () => {
    expect(minimumChatSubscribeMinorForTranscriptEvent(UNRELATED_EVENT)).toBe(
      0,
    );
  });
});

describe("supportsTranscriptRowsFor", () => {
  const belowFloor: SchemaVersion = {
    major: 1,
    minor: TRANSCRIPT_ROW_FLOOR - 1,
  };
  const atFloor: SchemaVersion = { major: 1, minor: TRANSCRIPT_ROW_FLOOR };

  it("is false below the floor when a floor-raising event is present", () => {
    expect(
      supportsTranscriptRowsFor(belowFloor, [
        AUTO_JUDGE_UNATTENDED_DENIAL_EVENT,
      ]),
    ).toBe(false);
  });

  it("is true exactly at the floor when a floor-raising event is present", () => {
    expect(
      supportsTranscriptRowsFor(atFloor, [AUTO_JUDGE_UNATTENDED_DENIAL_EVENT]),
    ).toBe(true);
  });

  it("is false when the handshake has not resolved (null) and a floor-raising event is present", () => {
    expect(
      supportsTranscriptRowsFor(null, [AUTO_JUDGE_UNATTENDED_DENIAL_EVENT]),
    ).toBe(false);
  });

  it("is true below the floor, at the floor, and when null, when no floor-raising event is present", () => {
    const events = [ORDINARY_APPROVAL_DENIED_EVENT, UNRELATED_EVENT];

    expect(supportsTranscriptRowsFor(belowFloor, events)).toBe(true);
    expect(supportsTranscriptRowsFor(atFloor, events)).toBe(true);
    expect(supportsTranscriptRowsFor(null, events)).toBe(true);
  });
});
