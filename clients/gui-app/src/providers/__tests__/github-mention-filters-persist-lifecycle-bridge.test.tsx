import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { GithubMentionRepository } from "@traycer/protocol/host/mention-schemas";
import { GithubMentionFiltersPersistLifecycleBridge } from "@/providers/github-mention-filters-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";
import type { GithubMentionFilter } from "@/lib/composer/mentions/github-mention-rows";
import { githubMentionFiltersKey } from "@/lib/persist";

/**
 * Mirrors ComposerRunSettingsPersistLifecycleBridge's own test harness
 * (`composer-run-settings-persist-lifecycle-bridge.test.tsx`), adapted to the
 * mention-filter store. The behavior under test is privacy, not just
 * plumbing: a repository selection names a GitHub host, owner and repo -
 * private coordinates for a private repository - so the bridge must wipe
 * them on sign-out rather than leaving them readable to the next account on
 * this profile.
 */

const ALICE_REPOSITORY: GithubMentionRepository = {
  githubHost: "github.com",
  owner: "acme",
  repo: "acme-private-repo",
};

const BOB_REPOSITORY: GithubMentionRepository = {
  githubHost: "github.com",
  owner: "beta",
  repo: "beta-private-repo",
};

const ALICE_FILTERS: Record<string, GithubMentionFilter> = {
  "epic-1\x1fpull-requests": {
    state: "open",
    involvement: "everyone",
    repository: ALICE_REPOSITORY,
  },
};

const BOB_FILTERS: Record<string, GithubMentionFilter> = {
  "epic-2\x1fissues": {
    state: "closed",
    involvement: "assigned",
    repository: BOB_REPOSITORY,
  },
};

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function resetGithubMentionFilterStore(): void {
  useGithubMentionFilterStore.persist.setOptions({
    name: githubMentionFiltersKey(null),
  });
  useGithubMentionFilterStore.getState().resetForTests();
}

function persistSnapshot(
  email: string | null,
  filtersByKey: Record<string, GithubMentionFilter>,
): void {
  window.localStorage.setItem(
    githubMentionFiltersKey(email),
    JSON.stringify({
      state: { filtersByKey },
      version: 1,
    }),
  );
}

describe("<GithubMentionFiltersPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetGithubMentionFilterStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetGithubMentionFilterStore();
  });

  it("retargets to the signed-in user's mention-filter bucket", async () => {
    persistSnapshot("alice@example.com", ALICE_FILTERS);
    resetAuth("signed-in", "alice@example.com");

    render(
      <GithubMentionFiltersPersistLifecycleBridge>
        <div />
      </GithubMentionFiltersPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey("alice@example.com"),
      );
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual(
        ALICE_FILTERS,
      );
    });
  });

  it("loads the second user's bucket without leaking the first user's repository selection", async () => {
    persistSnapshot("alice@example.com", ALICE_FILTERS);
    persistSnapshot("bob@example.com", BOB_FILTERS);

    render(
      <GithubMentionFiltersPersistLifecycleBridge>
        <div />
      </GithubMentionFiltersPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual(
        ALICE_FILTERS,
      );
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey("bob@example.com"),
      );
      const filters = useGithubMentionFilterStore.getState().filtersByKey;
      expect(filters).toEqual(BOB_FILTERS);
      // Alice's private repository must not survive the switch to bob.
      expect(JSON.stringify(filters)).not.toContain(ALICE_REPOSITORY.repo);
    });
  });

  it("signed-out wipes the bucket, removing the persisted repository coordinates from localStorage", async () => {
    const clearStorageSpy = vi.spyOn(
      useGithubMentionFilterStore.persist,
      "clearStorage",
    );

    render(
      <GithubMentionFiltersPersistLifecycleBridge>
        <div />
      </GithubMentionFiltersPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey("alice@example.com"),
      );
    });

    // A real write through the store, not a pre-seeded snapshot, so the
    // persist middleware itself is what puts the repository's private
    // coordinates into localStorage under alice's own bucket.
    act(() => {
      useGithubMentionFilterStore.getState().setFilter({
        epicId: "epic-1",
        section: "pull-requests",
        filter: {
          state: "open",
          involvement: "everyone",
          repository: ALICE_REPOSITORY,
        },
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(
        githubMentionFiltersKey("alice@example.com"),
      );
      expect(raw).not.toBeNull();
      expect(raw ?? "").toContain(ALICE_REPOSITORY.repo);
    });

    clearStorageSpy.mockClear();

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(clearStorageSpy).toHaveBeenCalledTimes(1);
      // The wipe is the privacy behavior under test: the repository's host,
      // owner and repo must not survive sign-out into the next account's
      // read of this profile.
      expect(
        window.localStorage.getItem(
          githubMentionFiltersKey("alice@example.com"),
        ),
      ).toBeNull();
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey(null),
      );
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual({});
    });

    clearStorageSpy.mockRestore();
  });
});
