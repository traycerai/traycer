import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ISSUE_MENTION_FILTER,
  DEFAULT_PULL_REQUEST_MENTION_FILTER,
} from "@/lib/composer/mentions/github-mention-rows";
import { githubMentionFiltersKey } from "@/lib/persist";
import {
  reconcileRepositorySelection,
  restoreUnrepresentedRepositorySelection,
  selectGithubMentionFilter,
  useGithubMentionFilterStore,
} from "@/stores/composer/github-mention-filter-store";

const STORAGE_KEY = githubMentionFiltersKey(null);

function resetStore(): void {
  window.localStorage.clear();
  useGithubMentionFilterStore.persist.setOptions({ name: STORAGE_KEY });
  useGithubMentionFilterStore.getState().resetForTests();
}

describe("github-mention-filter-store", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("resets to defaults by deleting the stored row so the funnel dot clears", () => {
    const epicId = "epic-1";
    useGithubMentionFilterStore.getState().setFilter({
      epicId,
      section: "pull-requests",
      filter: {
        ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
        involvement: "review-requested",
      },
    });

    expect(
      Object.hasOwn(
        useGithubMentionFilterStore.getState().filtersByKey,
        `${epicId}\x1fpull-requests`,
      ),
    ).toBe(true);

    useGithubMentionFilterStore.getState().setFilter({
      epicId,
      section: "pull-requests",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
    });

    expect(
      Object.hasOwn(
        useGithubMentionFilterStore.getState().filtersByKey,
        `${epicId}\x1fpull-requests`,
      ),
    ).toBe(false);
    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        epicId,
        "pull-requests",
      ),
    ).toEqual(DEFAULT_PULL_REQUEST_MENTION_FILTER);
  });

  it("always reads defaults when epicId is null", () => {
    // Even if a prior epic left something sticky, the epic-less composer
    // must never inherit it through the selector.
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "issues",
      filter: {
        ...DEFAULT_ISSUE_MENTION_FILTER,
        involvement: "mentions",
      },
    });

    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        null,
        "issues",
      ),
    ).toEqual(DEFAULT_ISSUE_MENTION_FILTER);
    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        null,
        "pull-requests",
      ),
    ).toEqual(DEFAULT_PULL_REQUEST_MENTION_FILTER);
  });

  it("persists a non-default filter per epic and section", () => {
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-a",
      section: "pull-requests",
      filter: {
        state: "merged",
        involvement: "authored",
        repository: {
          githubHost: "github.com",
          owner: "traycerai",
          repo: "traycer",
        },
      },
    });

    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        "epic-a",
        "pull-requests",
      ),
    ).toEqual({
      state: "merged",
      involvement: "authored",
      repository: {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer",
      },
    });
    // A different epic still sees defaults.
    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        "epic-b",
        "pull-requests",
      ),
    ).toEqual(DEFAULT_PULL_REQUEST_MENTION_FILTER);
  });

  it("partialize drops the landing bucket while keeping task-keyed rows across rehydrate", async () => {
    const taskFilter = {
      state: "merged" as const,
      involvement: "authored" as const,
      repository: {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer",
      },
    };
    const landingFilter = {
      state: "closed" as const,
      involvement: "assigned" as const,
      repository: null,
    };

    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-a",
      section: "pull-requests",
      filter: taskFilter,
    });
    useGithubMentionFilterStore.getState().setFilter({
      epicId: null,
      section: "issues",
      filter: landingFilter,
    });

    // In-session both buckets are live; only the task-keyed one may leave
    // the process.
    expect(
      Object.keys(useGithubMentionFilterStore.getState().filtersByKey).sort(),
    ).toEqual(["\x00landing\x1fissues", "epic-a\x1fpull-requests"]);

    // Let the persist middleware flush to localStorage.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: { filtersByKey?: Record<string, unknown> };
    };
    const persistedKeys = Object.keys(parsed.state?.filtersByKey ?? {});
    expect(persistedKeys).toEqual(["epic-a\x1fpull-requests"]);
    expect(persistedKeys.some((key) => key.includes("\x00landing"))).toBe(
      false,
    );

    // Simulate a reload: wipe memory (which also re-persists empty via the
    // middleware), re-seed storage with the partialized snapshot, rehydrate.
    useGithubMentionFilterStore.getState().resetForTests();
    window.localStorage.setItem(STORAGE_KEY, raw ?? "");
    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        "epic-a",
        "pull-requests",
      ),
    ).toEqual(DEFAULT_PULL_REQUEST_MENTION_FILTER);

    await useGithubMentionFilterStore.persist.rehydrate();

    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        "epic-a",
        "pull-requests",
      ),
    ).toEqual(taskFilter);
    // Landing never survived storage, so rehydrate cannot restore it.
    expect(
      selectGithubMentionFilter(
        useGithubMentionFilterStore.getState(),
        null,
        "issues",
      ),
    ).toEqual(DEFAULT_ISSUE_MENTION_FILTER);
  });
});

describe("reconcileRepositorySelection", () => {
  it("falls back to all repositories when the stored repo is not in scope", () => {
    const filter = {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      repository: {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "gone",
      },
    };
    const reconciled = reconcileRepositorySelection("pull-requests", filter, [
      {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer",
      },
    ]);
    expect(reconciled.repository).toBeNull();
    expect(reconciled.state).toBe("open");
    expect(reconciled.involvement).toBe("everyone");
  });

  it("keeps the selection when the repository is still one of several", () => {
    const repository = {
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
    };
    const filter = {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      repository,
    };
    const reconciled = reconcileRepositorySelection("pull-requests", filter, [
      repository,
      { githubHost: "github.com", owner: "traycerai", repo: "other" },
    ]);
    expect(reconciled).toBe(filter);
  });

  it("normalizes a selection that has become the whole scope", () => {
    // The popover only renders the Repository group for a multi-repository
    // scope, so a scope shrinking onto the selected repository would strand a
    // lit funnel dot no visible control can clear - and the stored selection
    // would start excluding rows again the moment another repository is
    // attached.
    const repository = {
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
    };
    const filter = {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      repository,
    };
    const reconciled = reconcileRepositorySelection("pull-requests", filter, [
      repository,
    ]);
    expect(reconciled.repository).toBeNull();
    expect(reconciled.state).toBe("open");
  });

  it("leaves an already-null repository selection alone", () => {
    const filter = DEFAULT_ISSUE_MENTION_FILTER;
    expect(
      reconcileRepositorySelection("issues", filter, [
        {
          githubHost: "github.com",
          owner: "a",
          repo: "b",
        },
      ]),
    ).toBe(filter);
  });

  it("normalizes the returned repository to the scope's own entry when casing differs", () => {
    // The stored selection and the scope's entry can be spelled with
    // different casing for the same repository - a persisted selection may
    // predate a remote being re-spelled. Matched case-insensitively, but the
    // returned repository must be the scope's OWN entry object, not a
    // rebuild of the stored one, so every downstream identity comparison
    // (the popover's radio, the row filter's key) agrees on one spelling.
    const scopeEntry = {
      githubHost: "github.com",
      owner: "TraycerAI",
      repo: "Traycer",
    };
    const filter = {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      repository: {
        githubHost: "GitHub.COM",
        owner: "traycerai",
        repo: "traycer",
      },
    };

    const reconciled = reconcileRepositorySelection("pull-requests", filter, [
      scopeEntry,
      { githubHost: "github.com", owner: "traycerai", repo: "other" },
    ]);

    expect(reconciled.repository).toBe(scopeEntry);
  });
});

describe("restoreUnrepresentedRepositorySelection", () => {
  it("returns next unchanged when nothing was stored", () => {
    // No stored selection means there is nothing to restore - the write-path
    // complement has no complement to apply.
    const next = DEFAULT_PULL_REQUEST_MENTION_FILTER;
    expect(
      restoreUnrepresentedRepositorySelection("pull-requests", next, null, [
        { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
      ]),
    ).toBe(next);
  });

  it("returns next unchanged when the stored repository is still represented, matched case-insensitively", () => {
    // Represented means the reconciled projection's decision stands: this
    // function only restores a selection reconcile had to DROP, and a
    // case-only spelling difference between the stored selection and the
    // scope's own entry is not a drop.
    const stored = {
      githubHost: "github.com",
      owner: "TraycerAI",
      repo: "Traycer",
    };
    const next = DEFAULT_PULL_REQUEST_MENTION_FILTER;
    expect(
      restoreUnrepresentedRepositorySelection("pull-requests", next, stored, [
        { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
      ]),
    ).toBe(next);
  });

  it("restores the stored repository onto next when the scope no longer represents it", () => {
    // The scope shrank or the folder detached, and `next` (the edit made
    // through the reconciled projection) carries no repository - so the
    // State/Involvement change must not also silently delete the stored
    // selection reconcile was only hiding as a display fallback.
    const stored = {
      githubHost: "github.com",
      owner: "traycerai",
      repo: "gone",
    };
    const next = DEFAULT_PULL_REQUEST_MENTION_FILTER;
    const restored = restoreUnrepresentedRepositorySelection(
      "pull-requests",
      next,
      stored,
      [{ githubHost: "github.com", owner: "traycerai", repo: "traycer" }],
    );
    expect(restored.repository).toBe(stored);
  });
});
