import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
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
import {
  publishEnvironmentArmScope,
  useEnvironmentArmGraphEvents,
} from "@/hooks/environment/use-environment-arms";

const EPIC_ID = "epic-test";
const FIRST_ENVIRONMENT = "environment-first";
const SECOND_ENVIRONMENT = "environment-second";

/** An arm stream the pool can end as it ends one for an unattached task. */
class ArmSession extends FakeStreamSession {
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
class PoolArmClient extends FakeStreamClient {
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

function armEvent(
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
function eventsFrame(input: {
  readonly generation: number;
  readonly events: readonly HostCommunicationGraphCloudFeedEvent[];
  readonly caughtUp: boolean;
}): StreamFrameEnvelope {
  const last = input.events[input.events.length - 1];
  const cursor: HostCommunicationGraphCloudFeedCursor = {
    ingestVersion: last.ingestVersion,
    eventId: last.eventId,
  };
  return {
    kind: "events",
    hasBinaryPayload: false,
    generation: input.generation,
    epicId: EPIC_ID,
    events: input.events,
    cursor,
    headVersion: 100,
    caughtUp: input.caughtUp,
  };
}

function eventIds(events: readonly HostCommunicationGraphCloudFeedEvent[]) {
  return events.map((event) => event.eventId);
}

describe("useEnvironmentArmGraphEvents caught-up gate", () => {
  let pool: PoolArmClient;

  /** The arm each environment opened. */
  function armOf(environmentId: string): ArmSession {
    const index = pool.subscribes.findIndex(
      (subscribe) =>
        typeof subscribe.params === "object" &&
        subscribe.params !== null &&
        "environmentId" in subscribe.params &&
        subscribe.params.environmentId === environmentId,
    );
    return pool.armSessions[index];
  }

  beforeEach(() => {
    pool = new PoolArmClient();
    publishEnvironmentArmScope({
      poolHostId: "pool-host-id",
      client: pool,
      viewerId: "viewer-1",
      environmentIds: [FIRST_ENVIRONMENT, SECOND_ENVIRONMENT],
      environmentIdByTeamId: new Map(),
      supported: new Set(["environment.communicationGraph.subscribe"]),
    });
  });

  afterEach(() => {
    publishEnvironmentArmScope(null);
    resetHostConnectionRegistryForTest();
  });

  it("is caught up only once every environment's arm has reached its head, however many pages it took", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    expect(pool.armSessions).toHaveLength(2);
    expect(view.result.current).toEqual({ events: [], caughtUp: false });

    // The second arm reaches its head at once; the first, delayed, has sent
    // nothing yet.
    act(() => {
      armOf(SECOND_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("second-1", 3)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(eventIds(view.result.current.events)).toEqual(["second-1"]);
    expect(view.result.current.caughtUp).toBe(false);

    // The first arm's first page is not its head yet.
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("first-1", 1)],
          caughtUp: false,
        }),
        null,
      );
    });
    expect(eventIds(view.result.current.events)).toEqual([
      "first-1",
      "second-1",
    ]);
    expect(view.result.current.caughtUp).toBe(false);

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("first-2", 2)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(eventIds(view.result.current.events)).toEqual([
      "first-1",
      "first-2",
      "second-1",
    ]);
    expect(view.result.current.caughtUp).toBe(true);
  });

  it("stays caught up through a later frame that is not, as a redial's gap is", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("first-1", 1)],
          caughtUp: true,
        }),
        null,
      );
      armOf(SECOND_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("second-1", 2)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(view.result.current.caughtUp).toBe(true);

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("first-2", 3)],
          caughtUp: false,
        }),
        null,
      );
    });

    expect(eventIds(view.result.current.events)).toContain("first-2");
    expect(view.result.current.caughtUp).toBe(true);
  });

  it("counts an arm the pool ended as caught up, with no events from it", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          generation: 0,
          events: [armEvent("first-1", 1)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(view.result.current.caughtUp).toBe(false);

    // The task is not attached to the second environment: its arm is refused.
    act(() => {
      armOf(SECOND_ENVIRONMENT).forbid();
    });

    expect(eventIds(view.result.current.events)).toEqual(["first-1"]);
    expect(view.result.current.caughtUp).toBe(true);
  });

  it("is caught up with no arm to read", () => {
    publishEnvironmentArmScope(null);

    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));

    expect(view.result.current).toEqual({ events: [], caughtUp: true });
  });
});
