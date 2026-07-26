import { describe, it, expect } from "vitest";
import type { PrActivityItem } from "@traycer/protocol/host/pr-schemas";
import {
  countPrConversationCards,
  groupPrConversation,
} from "../pr-conversation";

function review(args: {
  readonly id: string;
  readonly login: string | null;
  readonly state: Extract<PrActivityItem, { kind: "review" }>["state"];
  readonly body: string;
}): PrActivityItem {
  return {
    kind: "review",
    id: args.id,
    author: args.login === null ? null : { login: args.login, avatarUrl: null },
    body: args.body,
    state: args.state,
    createdAt: 1_000,
  };
}

function comment(args: {
  readonly id: string;
  readonly body: string;
}): PrActivityItem {
  return {
    kind: "comment",
    id: args.id,
    author: { login: "octocat", avatarUrl: null },
    body: args.body,
    createdAt: 1_000,
  };
}

describe("groupPrConversation", () => {
  it("folds consecutive body-less reviews from the same login and verdict into one counted event", () => {
    const entries = groupPrConversation([
      review({ id: "r1", login: "coderabbitai", state: "commented", body: "" }),
      review({ id: "r2", login: "coderabbitai", state: "commented", body: "" }),
      review({
        id: "r3",
        login: "coderabbitai",
        state: "commented",
        body: " ",
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "event",
      key: "review:r1",
      repeats: 3,
    });
  });

  it("does not fold across a change of verdict or of author", () => {
    const entries = groupPrConversation([
      review({ id: "r1", login: "coderabbitai", state: "commented", body: "" }),
      review({ id: "r2", login: "coderabbitai", state: "approved", body: "" }),
      review({ id: "r3", login: "tgill", state: "approved", body: "" }),
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "review:r1",
      "review:r2",
      "review:r3",
    ]);
    expect(entries.every((entry) => entry.kind === "event")).toBe(true);
  });

  it("does not fold across an intervening card", () => {
    const entries = groupPrConversation([
      review({ id: "r1", login: "coderabbitai", state: "commented", body: "" }),
      comment({ id: "c1", body: "a human says something" }),
      review({ id: "r2", login: "coderabbitai", state: "commented", body: "" }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "event",
      "card",
      "event",
    ]);
  });

  it("treats two unknown authors as the same actor rather than two nulls", () => {
    const entries = groupPrConversation([
      review({ id: "r1", login: null, state: "commented", body: "" }),
      review({ id: "r2", login: null, state: "commented", body: "" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repeats: 2 });
  });

  it("gives a review with a body a card, never an event", () => {
    const entries = groupPrConversation([
      review({
        id: "r1",
        login: "coderabbitai",
        state: "changes_requested",
        body: "The exp cap is not enforced offline.",
      }),
    ]);
    expect(entries[0]).toMatchObject({ kind: "card", key: "review:r1" });
  });

  it("keeps a body-less comment as a card - dropping it would hide a fact", () => {
    const entries = groupPrConversation([comment({ id: "c1", body: "" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "card", key: "comment:c1" });
  });

  it("counts only the entries that carry text", () => {
    const entries = groupPrConversation([
      review({ id: "r1", login: "coderabbitai", state: "commented", body: "" }),
      comment({ id: "c1", body: "hello" }),
      review({
        id: "r2",
        login: "tgill",
        state: "approved",
        body: "ship it",
      }),
    ]);
    expect(countPrConversationCards(entries)).toBe(2);
  });
});
