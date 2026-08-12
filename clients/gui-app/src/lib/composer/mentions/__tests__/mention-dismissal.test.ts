import { describe, expect, it } from "vitest";
import {
  isDismissedMentionQuery,
  shouldCloseMentionForNoMatches,
  type MentionNoMatchCloseInput,
} from "../mention-dismissal";

describe("isDismissedMentionQuery", () => {
  it("dismisses a query starting with a space", () => {
    expect(isDismissedMentionQuery(" ")).toBe(true);
    expect(isDismissedMentionQuery(" auth")).toBe(true);
  });

  it("dismisses a query containing a comma or semicolon", () => {
    expect(isDismissedMentionQuery("auth, then")).toBe(true);
    expect(isDismissedMentionQuery("auth;")).toBe(true);
  });

  it("dismisses a query containing a double space", () => {
    expect(isDismissedMentionQuery("auth  plan")).toBe(true);
    expect(isDismissedMentionQuery("auth  ")).toBe(true);
  });

  it("keeps multi-word titles and name punctuation searchable", () => {
    expect(isDismissedMentionQuery("")).toBe(false);
    expect(isDismissedMentionQuery("release notes")).toBe(false);
    expect(isDismissedMentionQuery("auth plan v2")).toBe(false);
    expect(isDismissedMentionQuery("src/lib/utils.ts")).toBe(false);
    expect(isDismissedMentionQuery("root-search-ranking.test.ts")).toBe(false);
    expect(isDismissedMentionQuery("chat:epic/123_draft")).toBe(false);
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
});
