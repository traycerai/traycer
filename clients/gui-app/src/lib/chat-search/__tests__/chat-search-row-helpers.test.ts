import { describe, expect, it } from "vitest";
import type { ChatSearchMessageHit } from "@traycer/protocol/host/chat-search/schemas";
import {
  chatSearchRoleLabels,
  chatSearchSnippetWindow,
  collapseIdenticalSnippets,
  projectSearchCount,
} from "@/lib/chat-search/chat-search-results";

function hit(input: {
  readonly messageId: string;
  readonly tier: ChatSearchMessageHit["tier"];
  readonly interAgent: boolean;
  readonly text: string;
}): ChatSearchMessageHit {
  return {
    messageId: input.messageId,
    tier: input.tier,
    createdAt: 1_000,
    interAgent: input.interAgent,
    truncated: false,
    snippet: { text: input.text, highlights: [] },
  };
}

function assistant(messageId: string, text: string): ChatSearchMessageHit {
  return hit({ messageId, tier: "assistant", interAgent: false, text });
}

describe("collapseIdenticalSnippets", () => {
  it("returns nothing for no hits", () => {
    expect(collapseIdenticalSnippets([])).toEqual([]);
  });

  it("keeps distinct snippets separate, in first-seen order", () => {
    const a = assistant("a", "alpha");
    const b = assistant("b", "beta");
    const result = collapseIdenticalSnippets([a, b]);
    expect(result.map((r) => r.representative)).toEqual([a, b]);
    expect(result.map((r) => r.count)).toEqual([1, 1]);
  });

  it("collapses same role and text, first hit is the representative", () => {
    const first = assistant("a", "same words");
    const second = assistant("b", "same words");
    const third = assistant("c", "same words");
    const result = collapseIdenticalSnippets([first, second, third]);
    expect(result).toHaveLength(1);
    expect(result[0]?.representative).toBe(first);
    expect(result[0]?.count).toBe(3);
    expect(result[0]?.members).toEqual([
      { messageId: "a", tier: "assistant" },
      { messageId: "b", tier: "assistant" },
      { messageId: "c", tier: "assistant" },
    ]);
  });

  it("treats whitespace differences as identical", () => {
    const result = collapseIdenticalSnippets([
      assistant("a", "hello world"),
      assistant("b", "  hello \n\t world  "),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(2);
  });

  it("does not collapse across roles", () => {
    const result = collapseIdenticalSnippets([
      assistant("a", "same"),
      hit({ messageId: "b", tier: "user", interAgent: false, text: "same" }),
      hit({ messageId: "c", tier: "user", interAgent: true, text: "same" }),
    ]);
    expect(result).toHaveLength(3);
  });

  it("does not collapse different text that only differs in case or words", () => {
    const result = collapseIdenticalSnippets([
      assistant("a", "Hello"),
      assistant("b", "hello"),
    ]);
    expect(result).toHaveLength(2);
  });

  it("drops a repeated (messageId, tier) before collapsing, so best is never counted twice", () => {
    const best = assistant("a", "same");
    const result = collapseIdenticalSnippets([
      best,
      assistant("a", "same"),
      assistant("b", "same"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.representative).toBe(best);
    expect(result[0]?.count).toBe(2);
    expect(result[0]?.members.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("treats the same messageId with a different tier as a separate document", () => {
    const result = collapseIdenticalSnippets([
      assistant("a", "one"),
      hit({ messageId: "a", tier: "notice", interAgent: false, text: "two" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("keeps best first when it is prepended to later-page hits", () => {
    const best = assistant("best", "shared");
    const later = assistant("later", "shared");
    const other = assistant("other", "different");
    const result = collapseIdenticalSnippets([best, other, later]);
    expect(result[0]?.representative).toBe(best);
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.representative).toBe(other);
  });
});

describe("chatSearchRoleLabels", () => {
  it("labels each role", () => {
    expect(chatSearchRoleLabels({ tier: "user", interAgent: false })).toEqual({
      short: "You",
      full: "You",
    });
    expect(chatSearchRoleLabels({ tier: "user", interAgent: true })).toEqual({
      short: "Other agent",
      full: "From another agent",
    });
    expect(
      chatSearchRoleLabels({ tier: "assistant", interAgent: false }),
    ).toEqual({ short: "Agent", full: "Agent reply" });
    expect(chatSearchRoleLabels({ tier: "notice", interAgent: false })).toEqual(
      { short: "Notice", full: "System notice" },
    );
    expect(chatSearchRoleLabels({ tier: "card", interAgent: false })).toEqual({
      short: "Action",
      full: "Action",
    });
  });

  it("ignores interAgent for non-user tiers", () => {
    expect(
      chatSearchRoleLabels({ tier: "assistant", interAgent: true }),
    ).toEqual({ short: "Agent", full: "Agent reply" });
  });
});

describe("chatSearchSnippetWindow", () => {
  const long = "x".repeat(100);

  it("returns the leading text when there are no highlights", () => {
    expect(chatSearchSnippetWindow(long, [], 10)).toEqual({
      text: "x".repeat(10),
      highlights: [],
      start: 0,
      end: 10,
    });
  });

  it("returns short text whole", () => {
    expect(chatSearchSnippetWindow("abc", [{ start: 1, end: 2 }], 20)).toEqual({
      text: "abc",
      highlights: [{ start: 1, end: 2 }],
      start: 0,
      end: 3,
    });
  });

  it("centres on a mid-text highlight and rebases it", () => {
    const result = chatSearchSnippetWindow(long, [{ start: 50, end: 55 }], 20);
    expect(result.start).toBe(43);
    expect(result.end).toBe(63);
    expect(result.text).toHaveLength(20);
    expect(result.highlights).toEqual([{ start: 7, end: 12 }]);
  });

  it("does not run past the start", () => {
    const result = chatSearchSnippetWindow(long, [{ start: 2, end: 5 }], 20);
    expect(result.start).toBe(0);
    expect(result.highlights).toEqual([{ start: 2, end: 5 }]);
  });

  it("does not run past the end", () => {
    const result = chatSearchSnippetWindow(long, [{ start: 95, end: 99 }], 20);
    expect(result.start).toBe(80);
    expect(result.end).toBe(100);
    expect(result.highlights).toEqual([{ start: 15, end: 19 }]);
  });

  it("keeps the window on the sliced text", () => {
    const text = "0123456789abcdefghijklmnopqrstuvwxyz";
    const result = chatSearchSnippetWindow(text, [{ start: 20, end: 23 }], 10);
    expect(result.text).toBe(text.slice(result.start, result.end));
    const [h] = result.highlights;
    expect(h).toBeDefined();
    expect(result.text.slice(h.start, h.end)).toBe("klm");
  });

  it("starts a highlight longer than the budget at its beginning, dropping later ones", () => {
    const result = chatSearchSnippetWindow(
      long,
      [
        { start: 10, end: 40 },
        { start: 45, end: 50 },
      ],
      10,
    );
    expect(result.start).toBe(10);
    expect(result.end).toBe(20);
    expect(result.highlights).toEqual([{ start: 0, end: 10 }]);
  });

  it("keeps several highlights that fit and rebases them all", () => {
    const result = chatSearchSnippetWindow(
      "x".repeat(40),
      [
        { start: 10, end: 12 },
        { start: 16, end: 18 },
      ],
      20,
    );
    expect(result.start).toBe(1);
    expect(result.highlights).toEqual([
      { start: 9, end: 11 },
      { start: 15, end: 17 },
    ]);
  });

  it("centres on the earliest highlight even when ranges arrive unsorted", () => {
    const result = chatSearchSnippetWindow(
      long,
      [
        { start: 80, end: 82 },
        { start: 50, end: 55 },
      ],
      20,
    );
    expect(result.start).toBe(43);
  });

  it("clamps a highlight past the end of the text", () => {
    const result = chatSearchSnippetWindow(long, [{ start: 90, end: 500 }], 20);
    expect(result.end).toBe(100);
    for (const h of result.highlights) {
      expect(h.start).toBeGreaterThanOrEqual(0);
      expect(h.end).toBeLessThanOrEqual(result.text.length);
    }
  });

  it("widens the window to keep an emoji whole at its leading edge", () => {
    // Budget 3 alone would start at unit 1, the emoji's low surrogate.
    const result = chatSearchSnippetWindow("😀abc", [{ start: 2, end: 3 }], 3);
    expect(result).toEqual({
      text: "😀ab",
      highlights: [{ start: 2, end: 3 }],
      start: 0,
      end: 4,
    });
  });

  it("widens the window to keep an emoji whole at its trailing edge", () => {
    expect(chatSearchSnippetWindow("abc😀", [{ start: 0, end: 1 }], 4)).toEqual(
      {
        text: "abc😀",
        highlights: [{ start: 0, end: 1 }],
        start: 0,
        end: 5,
      },
    );
    // No highlights: a one-unit budget still yields the whole emoji.
    expect(chatSearchSnippetWindow("😀abc", [], 1)).toEqual({
      text: "😀",
      highlights: [],
      start: 0,
      end: 2,
    });
  });

  it("keeps a combining mark with its base character", () => {
    const result = chatSearchSnippetWindow("éx", [], 1);
    expect(result.text).toBe("é");
    expect(result.start).toBe(0);
    expect(result.end).toBe(2);
  });

  it("rebases highlights against the snapped start", () => {
    // Raw start 3 lands inside the second emoji; snapped to 2, so the
    // highlight on "x" (unit 4) sits at offset 2, not 1.
    const result = chatSearchSnippetWindow(
      "😀😀xyz",
      [{ start: 4, end: 5 }],
      3,
    );
    expect(result.start).toBe(2);
    expect(result.text).toBe("😀xy");
    expect(result.highlights).toEqual([{ start: 2, end: 3 }]);
    const [h] = result.highlights;
    expect(result.text.slice(h.start, h.end)).toBe("x");
  });

  it("handles empty text and a zero budget", () => {
    expect(chatSearchSnippetWindow("", [], 10)).toEqual({
      text: "",
      highlights: [],
      start: 0,
      end: 0,
    });
    expect(chatSearchSnippetWindow(long, [{ start: 5, end: 8 }], 0)).toEqual({
      text: "",
      highlights: [],
      start: 5,
      end: 5,
    });
  });
});

describe("projectSearchCount", () => {
  it("projects a ready count, exact or with more", () => {
    expect(
      projectSearchCount({ kind: "ready", count: 7, more: false }),
    ).toEqual({
      kind: "count",
      value: 7,
      more: false,
    });
    expect(
      projectSearchCount({ kind: "ready", count: 25, more: true }),
    ).toEqual({
      kind: "count",
      value: 25,
      more: true,
    });
  });

  it("keeps a genuine zero as a count", () => {
    expect(
      projectSearchCount({ kind: "ready", count: 0, more: false }),
    ).toEqual({
      kind: "count",
      value: 0,
      more: false,
    });
  });

  it("is pending while loading", () => {
    expect(projectSearchCount({ kind: "loading" })).toEqual({
      kind: "pending",
    });
  });

  it("is none when absent or errored, never zero", () => {
    expect(projectSearchCount({ kind: "absent" })).toEqual({ kind: "none" });
    expect(projectSearchCount({ kind: "error" })).toEqual({ kind: "none" });
  });
});
