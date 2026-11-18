import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "../github-mention-rows";
import {
  EMPTY_STEP_CHROME,
  sameMentionStepChrome,
  type MentionStepChrome,
} from "../step-chrome";

function chrome(overrides: Partial<MentionStepChrome>): MentionStepChrome {
  return {
    ...EMPTY_STEP_CHROME,
    ...overrides,
  };
}

describe("sameMentionStepChrome", () => {
  it("treats identical references as equal", () => {
    const value = chrome({ emptyLabel: "No matches" });
    expect(sameMentionStepChrome(value, value)).toBe(true);
    expect(sameMentionStepChrome(null, null)).toBe(true);
  });

  it("treats null against a value as unequal", () => {
    expect(sameMentionStepChrome(null, chrome({}))).toBe(false);
    expect(sameMentionStepChrome(chrome({}), null)).toBe(false);
  });

  it("compares value-equal rebuilds equal so the store can damp republishes", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const left = chrome({
      refresh: {
        onRefresh,
        refreshing: false,
        label: "Refresh artifacts",
        targetKey: "scope-1\x1fpull-requests",
        timeoutMs: 10_000,
      },
      freshness: { updatedAt: 1_234, checking: false },
      notice: { kind: "rate-limited", retryAt: 9_999 },
      filter: {
        section: "pull-requests",
        epicId: "epic-1",
        repositories: [
          { githubHost: "github.com", owner: "a", repo: "b" },
          { githubHost: "github.com", owner: "c", repo: "d" },
        ],
        selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      },
      banner: { kind: "gh-unavailable", section: "issues" },
      appendedStatus: { label: "Searching GitHub…", busy: true },
      emptyLabel: "No GitHub repositories found in this task's folders.",
    });
    const right = chrome({
      refresh: {
        onRefresh,
        refreshing: false,
        label: "Refresh artifacts",
        targetKey: "scope-1\x1fpull-requests",
        timeoutMs: 10_000,
      },
      freshness: { updatedAt: 1_234, checking: false },
      notice: { kind: "rate-limited", retryAt: 9_999 },
      filter: {
        section: "pull-requests",
        epicId: "epic-1",
        repositories: [
          { githubHost: "github.com", owner: "a", repo: "b" },
          { githubHost: "github.com", owner: "c", repo: "d" },
        ],
        selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      },
      banner: { kind: "gh-unavailable", section: "issues" },
      appendedStatus: { label: "Searching GitHub…", busy: true },
      emptyLabel: "No GitHub repositories found in this task's folders.",
    });

    expect(sameMentionStepChrome(left, right)).toBe(true);
  });

  it("detects a changed onRefresh identity as unequal", () => {
    const left = chrome({
      refresh: {
        onRefresh: vi.fn(() => Promise.resolve()),
        refreshing: false,
        label: "Refresh",
        targetKey: "scope-1\x1fpull-requests",
        timeoutMs: 10_000,
      },
    });
    const right = chrome({
      refresh: {
        onRefresh: vi.fn(() => Promise.resolve()),
        refreshing: false,
        label: "Refresh",
        targetKey: "scope-1\x1fpull-requests",
        timeoutMs: 10_000,
      },
    });
    expect(sameMentionStepChrome(left, right)).toBe(false);
  });

  it("detects a changed repository list as unequal", () => {
    const left = chrome({
      filter: {
        section: "pull-requests",
        epicId: "epic-1",
        repositories: [{ githubHost: "github.com", owner: "a", repo: "b" }],
        selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      },
    });
    const right = chrome({
      filter: {
        section: "pull-requests",
        epicId: "epic-1",
        repositories: [{ githubHost: "github.com", owner: "a", repo: "other" }],
        selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      },
    });
    expect(sameMentionStepChrome(left, right)).toBe(false);
  });

  it("detects a changed freshness stamp as unequal", () => {
    const left = chrome({
      freshness: { updatedAt: 1, checking: false },
    });
    const right = chrome({
      freshness: { updatedAt: 2, checking: false },
    });
    expect(sameMentionStepChrome(left, right)).toBe(false);
  });
});
