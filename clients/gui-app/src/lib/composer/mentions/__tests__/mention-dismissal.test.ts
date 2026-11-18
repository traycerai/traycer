import { describe, expect, it } from "vitest";
import {
  isDismissedMentionQuery,
  shouldCloseMentionForNoMatches,
  type MentionNoMatchCloseInput,
} from "../mention-dismissal";

describe("isDismissedMentionQuery", () => {
  it("dismisses a query starting with a space", () => {
    expect(isDismissedMentionQuery(" ", false)).toBe(true);
    expect(isDismissedMentionQuery(" auth", false)).toBe(true);
    // Leading space still dismisses inside a PR/Issue section.
    expect(isDismissedMentionQuery(" ", true)).toBe(true);
    expect(isDismissedMentionQuery(" auth", true)).toBe(true);
  });

  it("dismisses a query containing a comma or semicolon outside GitHub sections", () => {
    expect(isDismissedMentionQuery("auth, then", false)).toBe(true);
    expect(isDismissedMentionQuery("auth;", false)).toBe(true);
  });

  it("does not dismiss comma or semicolon queries inside a GitHub section", () => {
    // Real PR titles: "fix(relay): stop the busy-loop, again"
    expect(
      isDismissedMentionQuery("fix(relay): stop the busy-loop, again", true),
    ).toBe(false);
    expect(isDismissedMentionQuery("auth;", true)).toBe(false);
    expect(isDismissedMentionQuery("auth, then", true)).toBe(false);
  });

  it("dismisses a query containing a double space", () => {
    expect(isDismissedMentionQuery("auth  plan", false)).toBe(true);
    expect(isDismissedMentionQuery("auth  ", false)).toBe(true);
    // Double space still dismisses inside a PR/Issue section.
    expect(isDismissedMentionQuery("auth  plan", true)).toBe(true);
    expect(isDismissedMentionQuery("auth  ", true)).toBe(true);
  });

  it("keeps multi-word titles and name punctuation searchable", () => {
    expect(isDismissedMentionQuery("", false)).toBe(false);
    expect(isDismissedMentionQuery("release notes", false)).toBe(false);
    expect(isDismissedMentionQuery("auth plan v2", false)).toBe(false);
    expect(isDismissedMentionQuery("src/lib/utils.ts", false)).toBe(false);
    expect(isDismissedMentionQuery("root-search-ranking.test.ts", false)).toBe(
      false,
    );
    expect(isDismissedMentionQuery("chat:epic/123_draft", false)).toBe(false);
  });
});

function closeInput(
  overrides: Partial<MentionNoMatchCloseInput>,
): MentionNoMatchCloseInput {
  return {
    stepKind: "root",
    query: "auth",
    debouncedQuery: "auth",
    matchedCount: 0,
    loading: false,
    fetching: false,
    sourcesErrored: false,
    referenceQuery: false,
    ...overrides,
  };
}

describe("shouldCloseMentionForNoMatches", () => {
  it("closes once the root search settled on zero real matches", () => {
    expect(shouldCloseMentionForNoMatches(closeInput({}))).toBe(true);
  });

  it("stays open while any real match exists", () => {
    expect(
      shouldCloseMentionForNoMatches(closeInput({ matchedCount: 1 })),
    ).toBe(false);
  });

  it("stays open while sources are still loading or refetching", () => {
    expect(shouldCloseMentionForNoMatches(closeInput({ loading: true }))).toBe(
      false,
    );
    expect(shouldCloseMentionForNoMatches(closeInput({ fetching: true }))).toBe(
      false,
    );
  });

  it("stays open while the debounced query trails the live query", () => {
    expect(
      shouldCloseMentionForNoMatches(
        closeInput({ query: "auth pl", debouncedQuery: "auth" }),
      ),
    ).toBe(false);
  });

  it("never closes the empty-query category menu or a provider step", () => {
    expect(
      shouldCloseMentionForNoMatches(
        closeInput({ query: "  ", debouncedQuery: "  ", matchedCount: null }),
      ),
    ).toBe(false);
    expect(
      shouldCloseMentionForNoMatches(closeInput({ stepKind: "provider" })),
    ).toBe(false);
  });

  it("stays open when any source errored - a failed search proves nothing empty", () => {
    expect(
      shouldCloseMentionForNoMatches(closeInput({ sourcesErrored: true })),
    ).toBe(false);
  });

  it("treats a null match count as not a ranked search", () => {
    expect(
      shouldCloseMentionForNoMatches(closeInput({ matchedCount: null })),
    ).toBe(false);
  });

  it("stays open for a reference-shaped query even when settled with zero matches", () => {
    expect(
      shouldCloseMentionForNoMatches(
        closeInput({
          query: "#4917",
          debouncedQuery: "#4917",
          matchedCount: 0,
          referenceQuery: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldCloseMentionForNoMatches(
        closeInput({
          query: "org/repo#123",
          debouncedQuery: "org/repo#123",
          matchedCount: 0,
          referenceQuery: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldCloseMentionForNoMatches(
        closeInput({
          query: "https://github.com/org/repo/pull/123",
          debouncedQuery: "https://github.com/org/repo/pull/123",
          matchedCount: 0,
          referenceQuery: true,
        }),
      ),
    ).toBe(false);
  });
});
