/**
 * How the bot tab reads `bot.open`'s answer (Tracy Bots): `botTabOpenState`
 * folds the outcome, an open error and what this client can dial into the
 * tab's state, and `botPausedCopy` says each paused reason without naming a
 * machine.
 */
import { describe, expect, it } from "vitest";
import type {
  BotOpenPausedReason,
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import {
  botPausedCopy,
  botTabOpenState,
  type BotTabPausedReason,
} from "../bot-tab-open-state";

const TAB_HOST = "host-tab";
const BOUND_HOST = "host-bound";
const ENVIRONMENT_LABEL = "acme";

const BOT: BotRecord = {
  botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: BOUND_HOST,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

function response(outcome: BotOpenResponse["outcome"]): BotOpenResponse {
  return { bot: BOT, outcome };
}

const PAUSED_REASONS: ReadonlyArray<BotOpenPausedReason> = [
  "host-not-in-environment",
  "bound-to-sandbox",
  "bound-host-not-observable",
  "reachability-unknown",
  "trunk-busy",
];

describe("botTabOpenState", () => {
  it("is opening before the host has answered", () => {
    expect(
      botTabOpenState({
        response: undefined,
        error: null,
      }),
    ).toEqual({ kind: "opening" });
  });

  it("is failed with the message when the open itself failed", () => {
    expect(
      botTabOpenState({
        response: undefined,
        error: "the host is unreachable",
      }),
    ).toEqual({ kind: "failed", message: "the host is unreachable" });
  });

  it("is serving when this host serves the bot, claimed or already bound", () => {
    const outcomes: ReadonlyArray<BotOpenResponse["outcome"]> = [
      { kind: "serve-here", claimed: null },
      { kind: "serve-here", claimed: "bound-host-unreachable" },
      { kind: "serve-here", claimed: "no-bound-host" },
    ];
    for (const outcome of outcomes) {
      expect(
        botTabOpenState({
          response: response(outcome),
          error: null,
        }),
      ).toEqual({ kind: "serving" });
    }
  });

  it("is serving, never moving, when another host serves it", () => {
    for (const why of ["reachable", "claimed-concurrently"] as const) {
      for (const hostId of [TAB_HOST, BOUND_HOST]) {
        expect(
          botTabOpenState({
            response: response({ kind: "serve-on-bound-host", hostId, why }),
            error: null,
          }),
        ).toEqual({ kind: "serving" });
      }
    }
  });

  it("carries every paused reason through unchanged", () => {
    for (const reason of PAUSED_REASONS) {
      expect(
        botTabOpenState({
          response: response({ kind: "paused", reason }),
          error: null,
        }),
      ).toEqual({ kind: "paused", reason });
    }
  });

  it("puts an error ahead of an answer", () => {
    expect(
      botTabOpenState({
        response: response({ kind: "serve-here", claimed: null }),
        error: "boom",
      }),
    ).toEqual({ kind: "failed", message: "boom" });
  });
});

describe("botPausedCopy", () => {
  const ALL_REASONS: ReadonlyArray<BotTabPausedReason> = PAUSED_REASONS;

  it("offers Retry only where asking again can change the answer", () => {
    const retryable = ALL_REASONS.filter(
      (reason) => botPausedCopy(reason, ENVIRONMENT_LABEL).retry,
    );
    expect(retryable).toEqual(["reachability-unknown", "trunk-busy"]);
  });

  it("says something for every reason and never names a machine", () => {
    // The copy takes the environment's label and nothing else: no host id or
    // host label can reach it, so none can appear in it.
    const hostWords = [TAB_HOST, BOUND_HOST, "Studio Mac", "Laptop", "host-"];
    for (const reason of ALL_REASONS) {
      const { text } = botPausedCopy(reason, ENVIRONMENT_LABEL);
      expect(text.length).toBeGreaterThan(0);
      for (const word of hostWords) {
        expect(text).not.toContain(word);
      }
    }
  });

  it("names the environment where it explains whose machine is involved", () => {
    expect(
      botPausedCopy("host-not-in-environment", ENVIRONMENT_LABEL).text,
    ).toContain(ENVIRONMENT_LABEL);
  });

  it("promises delivery only where a send really waits for a machine to return", () => {
    const waits = ALL_REASONS.filter((reason) =>
      botPausedCopy(reason, ENVIRONMENT_LABEL).text.includes("delivered"),
    );
    expect(waits).toEqual(["host-not-in-environment"]);
    // A moment-only pause makes no delivery promise.
    expect(botPausedCopy("trunk-busy", ENVIRONMENT_LABEL).text).not.toContain(
      "delivered",
    );
    expect(
      botPausedCopy("reachability-unknown", ENVIRONMENT_LABEL).text,
    ).not.toContain("delivered");
  });

  it("says only what the reader gets for the two answers that cannot show the conversation, and never that the machine is gone", () => {
    for (const reason of [
      "bound-to-sandbox",
      "bound-host-not-observable",
    ] as const) {
      const copy = botPausedCopy(reason, ENVIRONMENT_LABEL);
      expect(copy.text).toBe(
        "Couldn't check whether this bot is running. Messages you send still reach it.",
      );
      expect(copy.retry).toBe(false);
      expect(copy.text).not.toMatch(/back|away/i);
    }
  });
});
