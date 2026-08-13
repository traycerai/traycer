import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import type { MentionFlowStep } from "@/lib/composer/mentions";
import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "@/lib/composer/mentions/github-mention-rows";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";

/**
 * A repository selection is only DISPLAYABLE before the scope resolves, never
 * sendable.
 *
 * `filter` deliberately keeps a stored selection through an unresolved scope so
 * a cold open does not blank the radios for a paint. That is right for the
 * chrome, which shows it, and wrong for the search, which spends a request on
 * it: a selection is non-default, so `wanted` is satisfied with NO query typed,
 * and the roots changing under an open section is on its own enough to search
 * GitHub qualified by a repository that may have just left the scope - and to
 * offer the rows that come back as insertable.
 */

const searchCalls = vi.hoisted(() => ({ enabled: [] as boolean[] }));

const stable = vi.hoisted(() => ({
  rows: [] as ReadonlyArray<never>,
  repositories: [] as ReadonlyArray<never>,
  noop: (): Promise<void> => Promise.resolve(),
}));

/** Mutable: whether the host has answered for the current scope. */
const catalog = vi.hoisted(() => ({ scopeResolved: false }));

vi.mock("@/hooks/composer/use-github-mention-catalog", () => ({
  useGithubMentionCatalog: () => ({
    rows: stable.rows,
    repositories: stable.repositories,
    scopeResolved: catalog.scopeResolved,
    freshnessAt: null,
    sourceStatus: "ok",
    notice: null,
    isLoading: false,
    isChecking: false,
    isPlaceholder: false,
    refreshManually: stable.noop,
  }),
}));

vi.mock("@/hooks/composer/use-github-mention-search", () => ({
  useGithubMentionSearch: (args: { readonly enabled: boolean }) => {
    searchCalls.enabled.push(args.enabled);
    return {
      rows: stable.rows,
      sourceStatus: null,
      notice: null,
      isSearching: false,
      refresh: stable.noop,
    };
  },
}));

vi.mock("@/lib/relative-time", () => ({ useSampledNow: () => 0 }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

import { useGithubMentionSections } from "../use-github-mention-sections";

const PR_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "pull-requests",
  stepId: "pull-requests",
  workspacePath: null,
};

const SELECTED_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer",
} as const;

function renderSections() {
  return renderHook(() =>
    useGithubMentionSections({
      client: {} as HostClient<HostRpcRegistry>,
      active: true,
      step: PR_STEP,
      currentEpicId: "epic-1",
      mentionRoots: ["/repo"],
      query: "",
      debouncedQuery: "",
      limit: 20,
    }),
  );
}

/** Whether the search was asked to run on any render of this mount. */
function searchWasEnabled(): boolean {
  return searchCalls.enabled.some((enabled) => enabled);
}

beforeEach(() => {
  searchCalls.enabled = [];
  catalog.scopeResolved = false;
  useGithubMentionFilterStore.setState(
    useGithubMentionFilterStore.getInitialState(),
    true,
  );
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionSections search gate", () => {
  it("withholds the search while a stored repository is unreconciled", () => {
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
        repository: SELECTED_REPO,
      },
    });

    renderSections();

    expect(searchWasEnabled()).toBe(false);
  });

  it("searches once the scope resolves and the selection can be checked", () => {
    // The control for the gate's release. Without it the fix could be "never
    // search while a repository is selected", which would break the filter.
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
        repository: SELECTED_REPO,
      },
    });
    catalog.scopeResolved = true;

    renderSections();

    expect(searchWasEnabled()).toBe(true);
  });

  it("does not delay an unfiltered section's search on the unresolved scope", () => {
    // The other control, and the reason the gate is not simply `scopeResolved`:
    // with nothing selected there is no unvalidated qualifier to leak, so the
    // common cold open must still search the moment the user types.
    renderSections();

    expect(searchWasEnabled()).toBe(true);
  });
});
