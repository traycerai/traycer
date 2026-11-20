import { describe, expect, it } from "vitest";
import { ChatStreamClient } from "../chat-stream-client";
import {
  eventAppendedEnvelope,
  noopCallbacks,
  rangeEnvelope,
  snapshotEnvelope,
  stubClientAtVersion,
} from "./chat-stream-client-test-support";

/**
 * `ChatEvent.providerSelection` rides `chat.subscribe@1.44`. The shared stream
 * client decodes a windowed session with the live open union, so a consumer on
 * a 1.44 session must be handed the provenance through each callback a chat
 * event reaches it by - the snapshot's tail, a `range` response and the live
 * `eventAppended` frame - and an event without it must still be delivered.
 * What an OLDER peer's stream carries is the host's concern, pinned by the
 * protocol freeze test and the host emission test, not by this client.
 */

const PROVENANCE_MINOR = 44;

const PROVIDER_SELECTION = {
  homeAddress: "home-1",
  bindingVersion: 3,
  holderRevision: "self",
  dispatchedAt: 1700,
};

function chatEvent(
  eventId: string,
  withSelection: boolean,
): Record<string, unknown> {
  return {
    eventId,
    type: "turn.started",
    timestamp: 1001,
    clientActionId: null,
    // A harness no closed enum names: the live consumer reads actors open.
    actor: {
      type: "agent",
      harnessId: "acme-future-harness",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    message: null,
    turnId: "turn-1",
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
    ...(withSelection ? { providerSelection: PROVIDER_SELECTION } : {}),
  };
}

describe("ChatStreamClient delivers providerSelection on a negotiated 1.44 session", () => {
  function openClient() {
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: PROVENANCE_MINOR,
    });
    const heard = {
      snapshot: [] as unknown[],
      range: [] as unknown[],
      appended: [] as unknown[],
    };
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: noopCallbacks({
        onWindowedSnapshot: (frame) => {
          heard.snapshot.push(...frame.snapshot.tail.events);
        },
        onRange: (frame) => {
          heard.range.push(...frame.range.events);
        },
        onEventAppended: (frame) => {
          heard.appended.push(frame.event);
        },
      }),
    });
    return { client, session, heard };
  }

  it("hands the snapshot tail, a range response and eventAppended the provenance", () => {
    const { client, session, heard } = openClient();

    session.deliver(snapshotEnvelope([chatEvent("event-tail", true)], []));
    session.deliver(rangeEnvelope([chatEvent("event-range", true)], []));
    session.deliver(eventAppendedEnvelope(chatEvent("event-live", true)));

    expect(heard.snapshot).toHaveLength(1);
    expect(heard.snapshot[0]).toMatchObject({
      eventId: "event-tail",
      providerSelection: PROVIDER_SELECTION,
    });
    expect(heard.range).toHaveLength(1);
    expect(heard.range[0]).toMatchObject({
      eventId: "event-range",
      providerSelection: PROVIDER_SELECTION,
    });
    expect(heard.appended).toHaveLength(1);
    expect(heard.appended[0]).toMatchObject({
      eventId: "event-live",
      providerSelection: PROVIDER_SELECTION,
    });
    client.close();
  });

  it("still delivers an event that carries no provenance, leaving the key absent", () => {
    const { client, session, heard } = openClient();

    session.deliver(snapshotEnvelope([chatEvent("event-tail", false)], []));
    session.deliver(rangeEnvelope([chatEvent("event-range", false)], []));
    session.deliver(eventAppendedEnvelope(chatEvent("event-live", false)));

    for (const delivered of [heard.snapshot, heard.range, heard.appended]) {
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toHaveProperty("providerSelection");
    }
    client.close();
  });
});
