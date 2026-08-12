import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GithubMentionRow,
  GithubMentionSection,
  MentionGithubSearchRequest,
  MentionGithubSearchResponse,
} from "@traycer/protocol/host/mention-schemas";

import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "@/lib/composer/mentions/github-mention-rows";
import type { GithubMentionScope } from "@/hooks/composer/use-github-mention-catalog";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * What the live search may and may not hold across.
 *
 * `keepPreviousData` is on this query so a typed query does not blank the
 * remote hits on every keystroke. The axis it must NOT hold across is the
 * SCOPE: rows kept from the previous host/epic/roots are merged into the new
 * scope's list and stay selectable, so a user can commit a mention naming a
 * pull request the current scope cannot resolve.
 *
 * Driven through the real hook and a real QueryClient - the placeholder is
 * TanStack's own behaviour, so a test that stubbed it would only assert its
 * own stub.
 */

const request = vi.fn();

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1", isReady: true }),
}));

import { useGithubMentionSearch } from "../use-github-mention-search";

// `HostClient` is a class with ~40 private fields, so a structural stand-in
// cannot be asserted into it. `{} as HostClient<...>` is what this suite's
// neighbours already use; grafting on the one method `useHostQuery` calls is
// the same stand-in with behaviour attached.
const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  requestWithSignal: request,
});

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function pullRequest(number: number): GithubMentionRow {
  return {
    kind: "pull-request",
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer",
    number,
    title: `PR ${number}`,
    url: `https://github.com/traycerai/traycer/pull/${number}`,
    author: { login: "alice", avatarUrl: null },
    updatedAt: 1_000,
    buckets: ["recent"],
    state: "open",
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    reviewDecision: null,
    checksRollup: null,
  };
}

function answer(
  rows: ReadonlyArray<GithubMentionRow>,
): MentionGithubSearchResponse {
  return { rows: [...rows], sourceStatus: "ok", notice: null };
}

/** Answers the FIRST question and leaves every later one in flight. */
function answerOnly(
  match: (params: MentionGithubSearchRequest) => boolean,
  rows: ReadonlyArray<GithubMentionRow>,
): void {
  request.mockImplementation(
    (_method: string, params: MentionGithubSearchRequest) =>
      match(params)
        ? Promise.resolve(answer(rows))
        : new Promise<MentionGithubSearchResponse>(() => {
            // Still in flight - this is the window the placeholder covers.
          }),
  );
}

interface SearchProps {
  readonly scope: GithubMentionScope;
  readonly section: GithubMentionSection;
  readonly debouncedQuery: string;
}

const REPO_A: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a"],
};

function renderSearch(initialProps: SearchProps) {
  return renderHook(
    (props: SearchProps) =>
      useGithubMentionSearch({
        client,
        scope: props.scope,
        section: props.section,
        debouncedQuery: props.debouncedQuery,
        filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        enabled: true,
      }),
    { wrapper, initialProps },
  );
}

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("useGithubMentionSearch placeholder lane", () => {
  it("holds the previous answer while a newer QUERY for the same scope lands", async () => {
    answerOnly((params) => params.query === "auth", [pullRequest(11)]);

    const { result, rerender } = renderSearch({
      scope: REPO_A,
      section: "pull-requests",
      debouncedQuery: "auth",
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    rerender({
      scope: REPO_A,
      section: "pull-requests",
      debouncedQuery: "authz",
    });

    await waitFor(() => expect(result.current.isSearching).toBe(true));
    // The positive control. Without it, "withholds across a scope change"
    // would also pass against a hook that simply never holds anything.
    expect(result.current.rows.map((row) => row.number)).toEqual([11]);
  });

  it("withholds the previous answer across a ROOTS change", async () => {
    answerOnly(
      (params) => params.workspacePaths[0] === "/repo-a",
      [pullRequest(11)],
    );

    const { result, rerender } = renderSearch({
      scope: REPO_A,
      section: "pull-requests",
      debouncedQuery: "auth",
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    rerender({
      scope: { epicId: "epic-1", workspacePaths: ["/repo-b"] },
      section: "pull-requests",
      debouncedQuery: "auth",
    });

    await waitFor(() => expect(result.current.isSearching).toBe(true));
    expect(result.current.rows).toEqual([]);
    // Every derived fact goes with the rows: a `sourceStatus` left behind
    // would keep the previous scope's banner on this scope's chrome.
    expect(result.current.sourceStatus).toBeNull();
  });

  it("withholds the previous answer across an EPIC change", async () => {
    answerOnly((params) => params.epicId === "epic-1", [pullRequest(11)]);

    const { result, rerender } = renderSearch({
      scope: REPO_A,
      section: "pull-requests",
      debouncedQuery: "auth",
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    rerender({
      scope: { epicId: "epic-2", workspacePaths: ["/repo-a"] },
      section: "pull-requests",
      debouncedQuery: "auth",
    });

    await waitFor(() => expect(result.current.isSearching).toBe(true));
    expect(result.current.rows).toEqual([]);
  });

  it("withholds the previous answer across a SECTION change", async () => {
    answerOnly(
      (params) => params.section === "pull-requests",
      [pullRequest(11)],
    );

    const { result, rerender } = renderSearch({
      scope: REPO_A,
      section: "pull-requests",
      debouncedQuery: "auth",
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    rerender({
      scope: REPO_A,
      section: "issues",
      debouncedQuery: "auth",
    });

    await waitFor(() => expect(result.current.isSearching).toBe(true));
    expect(result.current.rows).toEqual([]);
  });
});
