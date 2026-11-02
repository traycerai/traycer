import type { Event, StackFrame } from "@sentry/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  reportVoiceMiss,
  type RouteSeen,
  type VoiceMissCause,
} from "../miss-report";
import type { RouterResult } from "../router";
import {
  filedMisses,
  NO_OFFERED_IDS,
  onlyMiss,
  scrubbedMisses,
  type FiledMiss,
} from "./fixtures/filed-misses";

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

function seenOf(
  route: RouterResult,
  words: Pick<RouteSeen, "pageTakesWords" | "actTakesWords">,
): RouteSeen {
  return {
    route,
    viewKind: "task",
    rowIds: ["action:tab.next", "agent.tell:chat_1"],
    offered: NO_OFFERED_IDS,
    segments: ["Close this", " tab please"],
    ...words,
  };
}

const NO_WORDS = { pageTakesWords: false, actTakesWords: false };

/** The ids of the router's answer, as they were shipped. */
function shippedTarget(miss: FiledMiss): Record<string, string | null> {
  return z
    .object({
      target: z.record(z.string(), z.string().nullable()),
    })
    .parse(miss.options.extra.route).target;
}

/** The one event filed. */
function filedOnce() {
  return onlyMiss(captureMessage.mock.calls);
}

describe("reportVoiceMiss", () => {
  beforeEach(() => {
    captureMessage.mockReset();
    isInitialized.mockReset();
    isInitialized.mockReturnValue(true);
  });

  it("files one info event grouped by page and kind, with the offered ids, the route's ids and the span", () => {
    const route = routeOf({}, {});

    reportVoiceMiss("missing", "missing", seenOf(route, NO_WORDS), null);

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0]?.[0]).toMatch(
      /^voice\.route\.miss task missing #\d+$/,
    );
    expect(captureMessage.mock.calls[0]?.[1]).toEqual({
      level: "info",
      tags: {
        viewKind: "task",
        missKind: "missing",
        routerAction: "missing",
        uncertain: "false",
        spanDropped: "none",
      },
      fingerprint: ["voice.route.miss", "task", "missing"],
      extra: {
        rows: ["action:tab.next", "agent.tell:chat_1"],
        route: {
          action: "missing",
          target: route.target,
          uncertain: false,
          choice: null,
          control: null,
        },
        span: "Close this tab please",
        spanWords: 4,
      },
    });
  });

  it("sends the router's ids and never its question or its span indices", () => {
    reportVoiceMiss(
      "missing",
      "missing",
      seenOf(
        routeOf({ question: "Did you mean the Quartz lantern?" }, {}),
        NO_WORDS,
      ),
      null,
    );

    const { extra } = filedOnce().options;
    expect(
      Object.keys(z.record(z.string(), z.unknown()).parse(extra.route)).sort(),
    ).toEqual(["action", "choice", "control", "target", "uncertain"]);
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain(
      "Quartz lantern",
    );
  });

  describe("the span", () => {
    it("is the segments the route points at, trimmed", () => {
      reportVoiceMiss(
        "missing",
        "missing",
        seenOf(
          routeOf({ span: { fromSegment: 1, toSegment: 1 } }, {}),
          NO_WORDS,
        ),
        null,
      );

      expect(filedOnce().options.extra).toMatchObject({
        span: "tab please",
        spanWords: 2,
      });
    });

    it("is held inside the utterance when the route points past its end", () => {
      reportVoiceMiss(
        "missing",
        "missing",
        seenOf(
          routeOf({ span: { fromSegment: 1, toSegment: 9 } }, {}),
          NO_WORDS,
        ),
        null,
      );

      expect(filedOnce().options.extra.span).toBe("tab please");
    });

    it.each([
      { name: "past the end", from: 5, to: 9 },
      { name: "reversed", from: 1, to: 0 },
    ])("is the whole utterance when the range is $name", ({ from, to }) => {
      reportVoiceMiss(
        "missing",
        "missing",
        seenOf(
          routeOf({ span: { fromSegment: from, toSegment: to } }, {}),
          NO_WORDS,
        ),
        null,
      );

      expect(filedOnce().options.extra.span).toBe("Close this tab please");
    });
  });

  describe("the words are left out, and counted", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly cause: VoiceMissCause;
      readonly route: RouterResult;
      readonly words: Pick<RouteSeen, "pageTakesWords" | "actTakesWords">;
      readonly dropped: string;
    }> = [
      {
        name: "an action that passes them on",
        cause: "chosen-act",
        route: routeOf({ action: "act" }, { actionId: "agent.tell:chat_1" }),
        words: { pageTakesWords: true, actTakesWords: true },
        dropped: "tell",
      },
      {
        name: "an act the router chose",
        cause: "chosen-act",
        route: routeOf({ action: "act" }, { actionId: "action:tab.close" }),
        words: NO_WORDS,
        dropped: "act",
      },
      {
        name: "a bot the answer named",
        cause: "missing",
        route: routeOf({}, { botId: "bot_tracy" }),
        words: NO_WORDS,
        dropped: "target",
      },
      {
        name: "a thread the answer named",
        cause: "missing",
        route: routeOf({}, { threadId: "th_worktrees" }),
        words: NO_WORDS,
        dropped: "target",
      },
      {
        name: "an agent the answer named",
        cause: "missing",
        route: routeOf({}, { agentId: "chat_1" }),
        words: NO_WORDS,
        dropped: "target",
      },
      {
        name: "a page that offers an action passing words on",
        cause: "missing",
        route: routeOf({}, {}),
        words: { pageTakesWords: true, actTakesWords: false },
        dropped: "agent-page",
      },
      {
        name: "a router unsure of its answer",
        cause: "unknown-action",
        route: routeOf({ action: "act", uncertain: true }, {}),
        words: NO_WORDS,
        dropped: "uncertain",
      },
      {
        name: "an act that passes them on, ahead of the act, the target and the page",
        cause: "chosen-act",
        route: routeOf({ action: "act" }, { botId: "bot_tracy" }),
        words: { pageTakesWords: true, actTakesWords: true },
        dropped: "tell",
      },
      {
        name: "an act the router chose, ahead of the target and the page",
        cause: "chosen-act",
        route: routeOf({ action: "act" }, { botId: "bot_tracy" }),
        words: { pageTakesWords: true, actTakesWords: false },
        dropped: "act",
      },
      {
        name: "a target, ahead of the page and the doubt",
        cause: "missing",
        route: routeOf({ uncertain: true }, { botId: "bot_tracy" }),
        words: { pageTakesWords: true, actTakesWords: false },
        dropped: "target",
      },
      {
        name: "a page that passes words on, ahead of the doubt",
        cause: "missing",
        route: routeOf({ uncertain: true }, {}),
        words: { pageTakesWords: true, actTakesWords: false },
        dropped: "agent-page",
      },
    ];

    it.each(cases)(
      "for $name: tagged $dropped, no span, the word count kept",
      ({ cause, route, words, dropped }) => {
        reportVoiceMiss("refused", cause, seenOf(route, words), null);

        const filed = filedOnce();
        expect(filed.options.tags.spanDropped).toBe(dropped);
        expect(filed.options.tags.uncertain).toBe(
          route.uncertain ? "true" : "false",
        );
        expect(filed.options.extra).toMatchObject({
          span: null,
          spanWords: 4,
        });
        expect(scrubbedMisses(captureMessage.mock.calls).join()).not.toContain(
          "Close this",
        );
      },
    );
  });

  describe("the ids the router's answer names", () => {
    it("ships a bot the router wrote itself as unlisted, drops the words, and leaves the sentence out of the whole event", () => {
      const sentence =
        "Tell Ada at ada.lovelace@example.com that my password is tangerine-oyster-42";

      reportVoiceMiss(
        "missing",
        "missing",
        seenOf(routeOf({}, { botId: sentence }), NO_WORDS),
        null,
      );

      const filed = filedOnce();
      expect(shippedTarget(filed).botId).toBe("unlisted");
      expect(filed.options.tags.spanDropped).toBe("target");
      const event = scrubbedMisses(captureMessage.mock.calls).join("\n");
      expect(event).not.toContain("ada.lovelace@example.com");
      expect(event).not.toContain("tangerine-oyster-42");
    });

    it.each([
      {
        name: "an action the page does not offer",
        actionId: "wake ada.lovelace@example.com now",
        shipped: "unlisted",
      },
      {
        name: "an action the page offers",
        actionId: "action:tab.next",
        shipped: "action:tab.next",
      },
    ])("ships $name as $shipped", ({ actionId, shipped }) => {
      reportVoiceMiss(
        "refused",
        "unknown-action",
        seenOf(routeOf({ action: "act" }, { actionId }), NO_WORDS),
        null,
      );

      expect(shippedTarget(filedOnce()).actionId).toBe(shipped);
      expect(
        scrubbedMisses(captureMessage.mock.calls).join("\n"),
      ).not.toContain("ada.lovelace@example.com");
    });

    it.each([
      {
        field: "environmentId",
        offered: { ...NO_OFFERED_IDS, environmentIds: new Set(["env-listed"]) },
        listed: { environmentId: "env-listed" },
        unlisted: { environmentId: "env-made-up" },
      },
      {
        field: "threadId",
        offered: { ...NO_OFFERED_IDS, threadIds: new Set(["th-listed"]) },
        listed: { threadId: "th-listed" },
        unlisted: { threadId: "th-made-up" },
      },
      {
        field: "itemId",
        offered: { ...NO_OFFERED_IDS, itemIds: new Set(["item-listed"]) },
        listed: { itemId: "item-listed" },
        unlisted: { itemId: "item-made-up" },
      },
      {
        field: "agentId",
        offered: { ...NO_OFFERED_IDS, agentIds: new Set(["agent-listed"]) },
        listed: { agentId: "agent-listed" },
        unlisted: { agentId: "agent-made-up" },
      },
    ])(
      "ships a listed $field as itself and an unlisted one as unlisted",
      ({ field, offered, listed, unlisted }) => {
        for (const target of [listed, unlisted]) {
          reportVoiceMiss(
            "missing",
            "missing",
            { ...seenOf(routeOf({}, target), NO_WORDS), offered },
            null,
          );
        }

        const [shippedListed, shippedUnlisted] = filedMisses(
          captureMessage.mock.calls,
        ).map(shippedTarget);
        expect(shippedListed[field]).toBe(Object.values(listed)[0]);
        expect(shippedUnlisted[field]).toBe("unlisted");
        expect(shippedUnlisted).toEqual({
          environmentId: null,
          botId: null,
          threadId: null,
          itemId: null,
          actionId: null,
          agentId: null,
          [field]: "unlisted",
        });
      },
    );

    it("ships a listed bot as itself", () => {
      reportVoiceMiss(
        "missing",
        "missing",
        {
          ...seenOf(routeOf({}, { botId: "bot_tracy" }), NO_WORDS),
          offered: { ...NO_OFFERED_IDS, botIds: new Set(["bot_tracy"]) },
        },
        null,
      );

      expect(shippedTarget(filedOnce()).botId).toBe("bot_tracy");
    });
  });

  describe("the counts", () => {
    it("sit beside the event's own extras", () => {
      reportVoiceMiss("missing", "missing", seenOf(routeOf({}, {}), NO_WORDS), {
        tiles: 3,
      });

      expect(filedOnce().options.extra).toMatchObject({
        tiles: 3,
        rows: ["action:tab.next", "agent.tell:chat_1"],
      });
    });

    it("never override the rows, the span or the word count", () => {
      reportVoiceMiss("missing", "missing", seenOf(routeOf({}, {}), NO_WORDS), {
        rows: 40,
        span: 7,
        spanWords: 99,
      });

      expect(filedOnce().options.extra).toMatchObject({
        rows: ["action:tab.next", "agent.tell:chat_1"],
        span: "Close this tab please",
        spanWords: 4,
      });
    });
  });

  describe("against the client's duplicate filter", () => {
    /** One stack for both events: the same call site files every miss. */
    const SAME_FRAMES: StackFrame[] = [
      {
        filename: "app:///assets/say-loop.js",
        function: "reportMiss",
        lineno: 1180,
        colno: 7,
      },
    ];

    /** The event the browser SDK builds for a message with `attachStacktrace` on. */
    function browserEvent(miss: FiledMiss, message: string): Event {
      return {
        message,
        level: "info",
        tags: miss.options.tags,
        extra: miss.options.extra,
        fingerprint: miss.options.fingerprint,
        exception: {
          values: [{ value: message, stacktrace: { frames: SAME_FRAMES } }],
        },
      };
    }

    /** Whether a fresh filter lets `second` through after `first`. */
    async function secondSurvives(first: Event, second: Event) {
      const { BrowserClient, dedupeIntegration } =
        await vi.importActual<typeof import("@sentry/browser")>(
          "@sentry/browser",
        );
      const client = new BrowserClient({
        integrations: [],
        stackParser: () => [],
        transport: () => ({
          send: () => Promise.resolve({}),
          flush: () => Promise.resolve(true),
        }),
      });
      const filter = dedupeIntegration();
      await filter.processEvent?.(first, {}, client);
      return (await filter.processEvent?.(second, {}, client)) !== null;
    }

    function fileTwoAlike(): readonly [FiledMiss, FiledMiss] {
      const seen = seenOf(routeOf({}, {}), NO_WORDS);
      reportVoiceMiss("missing", "missing", seen, null);
      reportVoiceMiss("missing", "missing", seen, null);
      const [first, second] = filedMisses(captureMessage.mock.calls);
      return [first, second];
    }

    it("lets the second of two alike misses through, grouped as one issue", async () => {
      const [first, second] = fileTwoAlike();

      expect(first.message).toMatch(/^voice\.route\.miss task missing #\d+$/);
      expect(second.message).toMatch(/^voice\.route\.miss task missing #\d+$/);
      expect(second.message).not.toBe(first.message);
      expect(first.options.fingerprint).toEqual([
        "voice.route.miss",
        "task",
        "missing",
      ]);
      expect(second.options.fingerprint).toEqual(first.options.fingerprint);
      expect(
        await secondSurvives(
          browserEvent(first, first.message),
          browserEvent(second, second.message),
        ),
      ).toBe(true);
    });

    it("would drop the second if the messages did not differ", async () => {
      const [first, second] = fileTwoAlike();
      const bare = (miss: FiledMiss) => miss.message.replace(/ #\d+$/, "");

      expect(bare(first)).toBe(bare(second));
      expect(
        await secondSurvives(
          browserEvent(first, bare(first)),
          browserEvent(second, bare(second)),
        ),
      ).toBe(false);
    });
  });

  it("files nothing where reporting is off", () => {
    isInitialized.mockReturnValue(false);

    reportVoiceMiss(
      "missing",
      "missing",
      seenOf(routeOf({}, {}), NO_WORDS),
      null,
    );

    expect(captureMessage).not.toHaveBeenCalled();
  });
});
