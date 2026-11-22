import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  ArmSession,
  PoolArmClient,
  armEvent,
  eventsFrame,
} from "@/hooks/environment/__tests__/arm-pool-test-support";
import {
  publishEnvironmentArmScope,
  reopenEnvironmentArms,
  useEnvironmentArmGraphEvents,
} from "@/hooks/environment/use-environment-arms";

const EPIC_ID = "epic-test";
const FIRST_ENVIRONMENT = "environment-first";
const SECOND_ENVIRONMENT = "environment-second";
const FIRST_TEAM = "team-first";

function eventIds(events: readonly HostCommunicationGraphCloudFeedEvent[]) {
  return events.map((event) => event.eventId);
}

describe("useEnvironmentArmGraphEvents history gate", () => {
  let pool: PoolArmClient;

  function opensOf(environmentId: string): number[] {
    return pool.subscribes.flatMap((subscribe, index) =>
      typeof subscribe.params === "object" &&
      subscribe.params !== null &&
      "environmentId" in subscribe.params &&
      subscribe.params.environmentId === environmentId
        ? [index]
        : [],
    );
  }

  /** The stream each environment's arm holds now: its latest open. */
  function armOf(environmentId: string): ArmSession {
    const opens = opensOf(environmentId);
    return pool.armSessions[opens[opens.length - 1]];
  }

  beforeEach(() => {
    pool = new PoolArmClient();
    publishEnvironmentArmScope({
      poolHostId: "pool-host-id",
      client: pool,
      viewerId: "viewer-1",
      environmentIds: [FIRST_ENVIRONMENT, SECOND_ENVIRONMENT],
      environmentIdByTeamId: new Map([[FIRST_TEAM, FIRST_ENVIRONMENT]]),
      supported: new Set(["environment.communicationGraph.subscribe"]),
    });
  });

  afterEach(() => {
    publishEnvironmentArmScope(null);
    resetHostConnectionRegistryForTest();
  });

  it("is settled only once every environment's arm has reached its head, however many pages it took", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    expect(pool.armSessions).toHaveLength(2);
    expect(view.result.current).toEqual({ events: [], historySettled: false });

    // The second arm reaches its head at once; the first, delayed, has sent
    // nothing yet.
    act(() => {
      armOf(SECOND_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("second-1", 3)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(eventIds(view.result.current.events)).toEqual(["second-1"]);
    expect(view.result.current.historySettled).toBe(false);

    // The first arm's first page is not its head yet.
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
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
    expect(view.result.current.historySettled).toBe(false);

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
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
    expect(view.result.current.historySettled).toBe(true);
  });

  it("stays settled through a later frame that is not, as a redial's gap is", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("first-1", 1)],
          caughtUp: true,
        }),
        null,
      );
      armOf(SECOND_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("second-1", 2)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(view.result.current.historySettled).toBe(true);

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("first-2", 3)],
          caughtUp: false,
        }),
        null,
      );
    });

    expect(eventIds(view.result.current.events)).toContain("first-2");
    expect(view.result.current.historySettled).toBe(true);
  });

  it("counts an arm the pool ended as settled, with no events from it", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("first-1", 1)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(view.result.current.historySettled).toBe(false);

    // The task is not attached to the second environment: its arm is refused.
    act(() => {
      armOf(SECOND_ENVIRONMENT).forbid();
    });

    expect(eventIds(view.result.current.events)).toEqual(["first-1"]);
    expect(view.result.current.historySettled).toBe(true);
  });

  it("starts an arm the pool ended over when the task is attached to it, and is settled again only once the fresh history is in", () => {
    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));
    // The task is not attached to the first environment yet: its arm is
    // refused, and the second environment's history is in.
    act(() => {
      armOf(FIRST_ENVIRONMENT).forbid();
      armOf(SECOND_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("second-1", 1)],
          caughtUp: true,
        }),
        null,
      );
    });
    expect(view.result.current.historySettled).toBe(true);

    act(() => {
      reopenEnvironmentArms(FIRST_TEAM, EPIC_ID);
    });

    expect(view.result.current.historySettled).toBe(false);
    const opens = opensOf(FIRST_ENVIRONMENT);
    expect(opens).toHaveLength(2);
    expect(pool.subscribes[opens[1]].params).toMatchObject({
      environmentId: FIRST_ENVIRONMENT,
      epicId: EPIC_ID,
      sinceCursor: null,
    });

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("first-1", 2)],
          caughtUp: false,
        }),
        null,
      );
    });
    expect(eventIds(view.result.current.events)).toEqual([
      "first-1",
      "second-1",
    ]);
    expect(view.result.current.historySettled).toBe(false);

    act(() => {
      armOf(FIRST_ENVIRONMENT).emit(
        eventsFrame({
          epicId: EPIC_ID,
          generation: 0,
          events: [armEvent("first-2", 3)],
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
    expect(view.result.current.historySettled).toBe(true);
  });

  it("is settled with no arm to read", () => {
    publishEnvironmentArmScope(null);

    const view = renderHook(() => useEnvironmentArmGraphEvents(EPIC_ID));

    expect(view.result.current).toEqual({ events: [], historySettled: true });
  });
});
