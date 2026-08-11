import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ISSUE_MENTION_FILTER,
  DEFAULT_PULL_REQUEST_MENTION_FILTER,
} from "@/lib/composer/mentions/github-mention-rows";
import { githubMentionFiltersKey } from "@/lib/persist";
import {
  reconcileRepositorySelection,
  selectGithubMentionFilter,
  useGithubMentionFilterStore,
} from "@/stores/composer/github-mention-filter-store";

const STORAGE_KEY = githubMentionFiltersKey();

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

  it("keeps the selection when the repository is still present", () => {
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
    expect(reconciled).toBe(filter);
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
});
