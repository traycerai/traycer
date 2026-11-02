import {
  chatSyncReaderFloorForTranscriptEvents,
  chatSyncReaderFloorForTranscriptMessages,
} from "@traycer/protocol/persistence/chat-sync/head";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import { describe, expect, it } from "vitest";

/**
 * A Slack message is a user payload kind no chat-sync reader below 1.13 can
 * decode, so a publication holding one, in a transcript row or in a queue
 * event, stamps a reader floor of 1.13. Canvas evidence keeps its 1.10
 * floor, and a publication holding both takes the higher.
 */

const SLACK_FLOOR = { major: 1, minor: 13 };
const CANVAS_FLOOR = { major: 1, minor: 10 };

const SLACK_PAYLOAD = {
  kind: "slack",
  content: { type: "doc", content: [] },
  author: {
    displayName: "Priya",
    slackUserId: "U0PRIYA01",
    traycerUserId: null,
  },
  ts: "1760000010.000100",
  trigger: "mention",
  followUp: false,
  omitted: [],
};

const CANVAS_USER_PAYLOAD = {
  kind: "user",
  content: { type: "doc", content: [] },
  browserAnnotations: [
    { kind: "browser-annotation", source: { kind: "canvas" } },
  ],
};

function userRow(message: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "user",
    messageId: "user-1",
    sender: { type: "user", userId: "user-1" },
    message,
    timestamp: 5,
    sessionAnchor: null,
  };
}

function queueAdded(message: Record<string, unknown>): ChatEvent {
  return {
    eventId: "e-added",
    type: "queue.added",
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
    metadata: { item: { kind: "prompt", queueItemId: "queue-1", message } },
  };
}

describe("chat-sync reader floor for a Slack message", () => {
  it("floors a transcript holding a Slack message at 1.13", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([userRow(SLACK_PAYLOAD)]),
    ).toEqual(SLACK_FLOOR);
  });

  it("floors a queued Slack prompt that only a queue event holds", () => {
    expect(
      chatSyncReaderFloorForTranscriptEvents([queueAdded(SLACK_PAYLOAD)]),
    ).toEqual(SLACK_FLOOR);
  });

  it("takes the Slack floor over the canvas one when a transcript holds both", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow(CANVAS_USER_PAYLOAD),
        userRow(SLACK_PAYLOAD),
      ]),
    ).toEqual(SLACK_FLOOR);
  });

  it("leaves a transcript without a Slack message at the floor it had", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        userRow({ kind: "user", content: { type: "doc", content: [] } }),
      ]),
    ).toBeNull();
    expect(
      chatSyncReaderFloorForTranscriptMessages([userRow(CANVAS_USER_PAYLOAD)]),
    ).toEqual(CANVAS_FLOOR);
    expect(
      chatSyncReaderFloorForTranscriptEvents([
        queueAdded({ kind: "user", content: { type: "doc", content: [] } }),
      ]),
    ).toBeNull();
  });
});
