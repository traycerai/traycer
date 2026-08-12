import { describe, expect, it, vi } from "vitest";
import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";

import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "../github-mention-rows";
import {
  GITHUB_MENTION_EMPTY_SCOPE_LABEL,
  GITHUB_MENTION_ERRORED_LABEL,
  GITHUB_MENTION_REFRESH_TIMEOUT_MS,
  GITHUB_MENTION_SEARCHING_LABEL,
  githubMentionChromeFor,
  type GithubMentionChromeInput,
} from "../github-mention-chrome";

const RATE_LIMITED: PrSourceNotice = {
  kind: "rate-limited",
  retryAt: 9_999,
};

const BACKING_OFF: PrSourceNotice = {
  kind: "backing-off",
  retryAt: null,
};

function baseInput(
  overrides: Partial<GithubMentionChromeInput>,
): GithubMentionChromeInput {
  return {
    section: "pull-requests",
    scopeKey: "scope-1",
    epicId: "epic-1",
    searchSourceStatus: null,
    repositories: [
      {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer",
      },
    ],
    selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
    scopeResolved: true,
    sourceStatus: "ok",
    catalogNotice: null,
    searchNotice: null,
    freshnessAt: 1_000,
    checking: false,
    searching: false,
    errored: false,
    onRefresh: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("githubMentionChromeFor — gh-unavailable notice suppression", () => {
  it("suppresses the ⓘ even when a notice is supplied, and raises the banner", () => {
    // Safety property: host is contracted to send notice:null on this status,
    // but a host that breaks the contract must still degrade to one honest
    // message — not a pause countdown that never resolves. Passing a real
    // notice here is load-bearing: catalogNotice:null would still pass if the
    // suppression line were deleted.
    const chrome = githubMentionChromeFor(
      baseInput({
        section: "issues",
        sourceStatus: "gh-unavailable",
        catalogNotice: RATE_LIMITED,
        searchNotice: BACKING_OFF,
      }),
    );

    expect(chrome.notice).toBeNull();
    expect(chrome.banner).toEqual({
      kind: "gh-unavailable",
      section: "issues",
    });
  });

  /**
   * The SEARCH is the read that can discover this first. The catalog read is
   * cache-only, so a host whose `gh` disappeared after the last sweep still
   * answers it happily - and building the banner from the catalog alone left
   * the typed search returning nothing with no explanation on screen.
   */
  it("raises the banner when only the live search reports gh-unavailable", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        section: "pull-requests",
        sourceStatus: "cached",
        catalogNotice: null,
        searchSourceStatus: "gh-unavailable",
      }),
    );

    expect(chrome.banner).toEqual({
      kind: "gh-unavailable",
      section: "pull-requests",
    });
    expect(chrome.notice).toBeNull();
  });

  it("passes the notice through and keeps the banner null when gh is available", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        sourceStatus: "ok",
        catalogNotice: RATE_LIMITED,
      }),
    );

    expect(chrome.banner).toBeNull();
    expect(chrome.notice).toEqual(RATE_LIMITED);
  });

  it("lets the catalog notice win over the search notice", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        sourceStatus: "partial",
        catalogNotice: RATE_LIMITED,
        searchNotice: BACKING_OFF,
      }),
    );

    expect(chrome.notice).toEqual(RATE_LIMITED);
    expect(chrome.notice).not.toEqual(BACKING_OFF);
  });

  it("falls through to the search notice when the catalog has none", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        sourceStatus: "ok",
        catalogNotice: null,
        searchNotice: BACKING_OFF,
      }),
    );

    expect(chrome.notice).toEqual(BACKING_OFF);
  });
});

describe("githubMentionChromeFor — emptyLabel gating", () => {
  it("stays silent before the host has answered, even with empty repositories", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        scopeResolved: false,
        repositories: [],
      }),
    );
    expect(chrome.emptyLabel).toBeNull();
  });

  it("claims an empty scope only after the host answers with zero repositories", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        scopeResolved: true,
        repositories: [],
      }),
    );
    expect(chrome.emptyLabel).toBe(GITHUB_MENTION_EMPTY_SCOPE_LABEL);
  });

  it("does not set emptyLabel when the scope has repositories", () => {
    const chrome = githubMentionChromeFor(
      baseInput({
        scopeResolved: true,
        repositories: [
          {
            githubHost: "github.com",
            owner: "traycerai",
            repo: "traycer",
          },
        ],
      }),
    );
    expect(chrome.emptyLabel).toBeNull();
  });
});

describe("githubMentionChromeFor — refresh, searching, and leash", () => {
  it("appends the searching label only while searching", () => {
    expect(
      githubMentionChromeFor(baseInput({ searching: true })).appendedStatus,
    ).toEqual({ label: GITHUB_MENTION_SEARCHING_LABEL, busy: true });
    expect(
      githubMentionChromeFor(baseInput({ searching: false })).appendedStatus,
    ).toBeNull();
  });

  it("uses a per-section refresh label", () => {
    expect(
      githubMentionChromeFor(baseInput({ section: "pull-requests" })).refresh
        ?.label,
    ).toBe("Refresh pull requests");
    expect(
      githubMentionChromeFor(baseInput({ section: "issues" })).refresh?.label,
    ).toBe("Refresh issues");
  });

  it("keeps the 20s refresh leash, not the artifacts 10s", () => {
    const chrome = githubMentionChromeFor(baseInput({}));
    expect(chrome.refresh?.timeoutMs).toBe(GITHUB_MENTION_REFRESH_TIMEOUT_MS);
    expect(chrome.refresh?.timeoutMs).toBe(20_000);
    // A tidy-up that collapsed this onto the artifacts leash would break the
    // honest spinner for a ~17s gh sweep.
    expect(chrome.refresh?.timeoutMs).toBeGreaterThan(10_000);
  });

  it("publishes the reconciled selection on the filter slot as given", () => {
    const selected = {
      state: "merged" as const,
      involvement: "authored" as const,
      repository: null,
    };
    const chrome = githubMentionChromeFor(
      baseInput({ epicId: null, selected }),
    );
    expect(chrome.filter).toEqual({
      section: "pull-requests",
      epicId: null,
      repositories: baseInput({}).repositories,
      selected,
    });
  });
});

describe("githubMentionChromeFor — errored appended status", () => {
  it("appends the errored row when the read failed outright and nothing is searching", () => {
    // A rejection carries no response, so none of the answered chrome can
    // move on it - the appended row is the only honest report that the ask
    // died, and it must show whenever the section is not mid-retry.
    const chrome = githubMentionChromeFor(
      baseInput({ errored: true, searching: false }),
    );
    expect(chrome.appendedStatus).toEqual({
      label: GITHUB_MENTION_ERRORED_LABEL,
      busy: false,
    });
  });

  it("lets a fresh search supersede the old failure", () => {
    // Retries keep `searching` true for as long as they run, so the row that
    // shows while a retry is in flight must be the searching row - a new ask
    // supersedes the old one, and a spinning row must never claim `busy: false`.
    const chrome = githubMentionChromeFor(
      baseInput({ errored: true, searching: true }),
    );
    expect(chrome.appendedStatus).toEqual({
      label: GITHUB_MENTION_SEARCHING_LABEL,
      busy: true,
    });
  });

  it("appends nothing once neither searching nor errored is true", () => {
    // The control: `errored: false` (the default `baseInput` already carries)
    // must not itself grow a row - only `searching` or a real `errored: true`
    // do.
    const chrome = githubMentionChromeFor(
      baseInput({ errored: false, searching: false }),
    );
    expect(chrome.appendedStatus).toBeNull();
  });
});
