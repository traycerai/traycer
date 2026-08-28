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

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    // userId and email deliberately DIFFER: a fixture that equates them
    // cannot detect email-keyed scoping.
    const userId = `user:${email}`;
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
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
  bucketIdentity: string | null,
  filtersByKey: Record<string, GithubMentionFilter>,
): void {
  window.localStorage.setItem(
    githubMentionFiltersKey(bucketIdentity),
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

  it("adopts the legacy email-keyed bucket into the signed-in user's canonical bucket", async () => {
    // Seeds ONLY the legacy (email-keyed) bucket, so a successful load can
    // only be explained by the one-shot adoption path onto the userId key.
    persistSnapshot(ALICE_EMAIL, ALICE_FILTERS);
    resetAuth("signed-in", ALICE_EMAIL);

    render(
      <GithubMentionFiltersPersistLifecycleBridge>
        <div />
      </GithubMentionFiltersPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey(ALICE_ID),
      );
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual(
        ALICE_FILTERS,
      );
    });
  });

  it("loads the second user's bucket without leaking the first user's repository selection", async () => {
    persistSnapshot(ALICE_ID, ALICE_FILTERS);
    persistSnapshot(BOB_ID, BOB_FILTERS);

    render(
      <GithubMentionFiltersPersistLifecycleBridge>
        <div />
      </GithubMentionFiltersPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual(
        ALICE_FILTERS,
      );
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey(BOB_ID),
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
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey(ALICE_ID),
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
        githubMentionFiltersKey(ALICE_ID),
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
        window.localStorage.getItem(githubMentionFiltersKey(ALICE_ID)),
      ).toBeNull();
      expect(useGithubMentionFilterStore.persist.getOptions().name).toBe(
        githubMentionFiltersKey(null),
      );
      expect(useGithubMentionFilterStore.getState().filtersByKey).toEqual({});
    });

    clearStorageSpy.mockRestore();
  });
});
