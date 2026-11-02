import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportVoiceMiss, type RouteSeen } from "../miss-report";
import type { RouterResult } from "../router";
import { filedMisses } from "./fixtures/filed-misses";

const captureMessage = vi.hoisted(() => vi.fn());
const isInitialized = vi.hoisted(() => vi.fn(() => true));

vi.mock("@sentry/browser", () => ({ captureMessage, isInitialized }));

function routeOf(
  overrides: Partial<RouterResult>,
  target: Partial<RouterResult["target"]>,
): RouterResult {
  return {
    action: "missing",
    target: {
      environmentId: null,
      botId: null,
      threadId: null,
      itemId: null,
      actionId: null,
      agentId: null,
      ...target,
    },
    span: { fromSegment: 0, toSegment: 1 },
    uncertain: false,
    question: null,
    control: null,
    choice: null,
    ...overrides,
  };
}

function seenOf(route: RouterResult): RouteSeen {
  return {
    route,
    viewKind: "task",
    rowIds: ["action:tab.next", "agent.tell:chat_1"],
    segments: ["Close this", " tab please"],
  };
}

/** The `extra` of the one event filed. */
function filedExtra(): Record<string, unknown> {
  const filed = filedMisses(captureMessage.mock.calls);
  expect(filed).toHaveLength(1);
  return filed[0]?.options.extra ?? {};
}

describe("reportVoiceMiss", () => {
  beforeEach(() => {
    captureMessage.mockReset();
    isInitialized.mockReset();
    isInitialized.mockReturnValue(true);
  });

  it("files one info event grouped by page and kind, with the offered ids, the route and the span", () => {
    const route = routeOf({}, {});

    reportVoiceMiss("missing", seenOf(route), null);

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith("voice.route.miss", {
      level: "info",
      tags: {
        viewKind: "task",
        missKind: "missing",
        routerAction: "missing",
        uncertain: "false",
      },
      fingerprint: ["voice.route.miss", "task", "missing"],
      extra: {
        rows: ["action:tab.next", "agent.tell:chat_1"],
        route,
        span: "Close this tab please",
      },
    });
  });

  it("tags a route the router was unsure of as uncertain true", () => {
    reportVoiceMiss(
      "refused",
      seenOf(routeOf({ action: "act", uncertain: true }, {})),
      null,
    );

    expect(
      filedMisses(captureMessage.mock.calls).at(0)?.options.tags,
    ).toMatchObject({
      routerAction: "act",
      uncertain: "true",
    });
  });

  describe("the span", () => {
    it("is the segments the route points at, trimmed", () => {
      reportVoiceMiss(
        "missing",
        seenOf(routeOf({ span: { fromSegment: 1, toSegment: 1 } }, {})),
        null,
      );

      expect(filedExtra().span).toBe("tab please");
    });

    it("is held inside the utterance when the route points past its end", () => {
      reportVoiceMiss(
        "missing",
        seenOf(routeOf({ span: { fromSegment: 1, toSegment: 9 } }, {})),
        null,
      );

      expect(filedExtra().span).toBe("tab please");
    });

    it.each([
      { name: "past the end", from: 5, to: 9 },
      { name: "reversed", from: 1, to: 0 },
    ])("is the whole utterance when the range is $name", ({ from, to }) => {
      reportVoiceMiss(
        "missing",
        seenOf(routeOf({ span: { fromSegment: from, toSegment: to } }, {})),
        null,
      );

      expect(filedExtra().span).toBe("Close this tab please");
    });

    it.each([
      { name: "a bot", target: { botId: "bot_tracy" } },
      { name: "only a thread", target: { threadId: "th_worktrees" } },
    ])("is null when the route named $name", ({ target }) => {
      reportVoiceMiss("missing", seenOf(routeOf({}, target)), null);

      expect(filedExtra().span).toBeNull();
    });
  });

  describe("the counts", () => {
    it("sit beside the event's own extras", () => {
      reportVoiceMiss("missing", seenOf(routeOf({}, {})), { tiles: 3 });

      expect(filedExtra()).toMatchObject({
        tiles: 3,
        rows: ["action:tab.next", "agent.tell:chat_1"],
      });
    });

    it("never override the rows or the span", () => {
      reportVoiceMiss("missing", seenOf(routeOf({}, {})), {
        rows: 40,
        span: 7,
      });

      expect(filedExtra()).toMatchObject({
        rows: ["action:tab.next", "agent.tell:chat_1"],
        span: "Close this tab please",
      });
    });
  });

  it("files nothing where reporting is off", () => {
    isInitialized.mockReturnValue(false);

    reportVoiceMiss("missing", seenOf(routeOf({}, {})), null);

    expect(captureMessage).not.toHaveBeenCalled();
  });
});
