/**
 * A fake of the pool's side of the environment arms: every subscription is an
 * open stream a test drives with the protocol's frames.
 */

import {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type {
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  HostCommunicationGraphCloudFeedCursor,
  HostCommunicationGraphCloudFeedEvent,
} from "@traycer/protocol/host/epic/communication-graph";

/** An arm stream the pool can end as it ends one for an unattached task. */
export class ArmSession extends FakeStreamSession {
  private statusListener: StatusChangeHandler | null = null;

  override onStatusChange(handler: StatusChangeHandler): void {
    this.statusListener = handler;
    super.onStatusChange(handler);
  }

  forbid(): void {
    this.statusListener?.(
      "closed",
      {
        kind: "fatalError",
        details: {
          code: "FORBIDDEN",
          reason: "FORBIDDEN: access denied.",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
      null,
      null,
    );
  }
}

/** The pool's stream client: every subscription an open {@link ArmSession}. */
export class PoolArmClient extends FakeStreamClient {
  readonly armSessions: ArmSession[] = [];

  constructor() {
    super(true);
  }

  override subscribe(method: string, params: unknown): ArmSession {
    const session = new ArmSession();
    this.armSessions.push(session);
    this.subscribes.push({ method, params });
    session.emitStatus("open");
    return session;
  }
}

export function armEvent(
  eventId: string,
  ingestVersion: number,
): HostCommunicationGraphCloudFeedEvent {
  return {
    eventId,
    originHostId: "host-team",
    originSequence: ingestVersion,
    ingestVersion,
    kind: "a2a_message",
    capturedAt: ingestVersion * 10,
    senderAgentId: null,
    receiverAgentId: null,
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: eventId,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    historicalUpload: false,
    peerEpicId: null,
  };
}

/** One page of an arm's history, as the pool's stream frames it. */
export function eventsFrame(input: {
  readonly epicId: string;
  readonly generation: number;
  readonly events: readonly HostCommunicationGraphCloudFeedEvent[];
  readonly caughtUp: boolean;
}): StreamFrameEnvelope {
  const last = input.events.at(-1);
  const cursor: HostCommunicationGraphCloudFeedCursor | null =
    last === undefined
      ? null
      : { ingestVersion: last.ingestVersion, eventId: last.eventId };
  return {
    kind: "events",
    hasBinaryPayload: false,
    generation: input.generation,
    epicId: input.epicId,
    events: input.events,
    cursor,
    headVersion: 100,
    caughtUp: input.caughtUp,
  };
}
