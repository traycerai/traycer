import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import {
  DEFAULT_PULL_REQUEST_MENTION_FILTER,
  type GithubMentionFilter,
} from "@/lib/composer/mentions/github-mention-rows";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Captures the enablement decision `useGithubMentionSearch` hands to
 * `useHostQuery`, and stands in for the underlying query's own `isError` /
 * `isFetching` - the two flags `errored` and `isSearching` are gated on
 * `wanted` and read straight off of. A fixed stand-in rather than a real
 * `QueryClient` because these cases are about that gating, not about
 * TanStack's retry mechanics - `useGithubMentionSearch errored` below sets
 * `isError` directly to stand for "retries against a rejected
 * `mention.githubSearch` are exhausted".
 */
const captured = vi.hoisted(() => ({
  enabled: null as boolean | null,
  isError: false,
  isFetching: false,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { readonly options: { readonly enabled: boolean } }) => {
    captured.enabled = args.options.enabled;
    return {
      data: undefined,
      isFetching: captured.isFetching,
      isError: captured.isError,
    };
  },
}));

// The hook reads readiness directly, to build the placeholder lane out of the
// same host id `useHostQuery` keys the cache by. Mocking `useHostQuery` alone
// no longer covers that read, and this suite's client is a bare stand-in with
// no `getActiveHostId`. The lane is not what these cases are about - it has
// its own suite in `use-github-mention-search-scope.test.tsx`, which drives
// the real readiness path.
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: true,
  }),
}));

import { useGithubMentionSearch } from "../use-github-mention-search";

const fakeClient = {} as HostClient<HostRpcRegistry>;

const scope = {
  epicId: "epic-1",
  workspacePaths: ["/repo"],
} as const;

interface SearchInput {
  readonly debouncedQuery: string;
  readonly filter: GithubMentionFilter;
  readonly enabled: boolean;
}

function renderSearch(initialProps: SearchInput) {
  return renderHook(
    (props: SearchInput) =>
      useGithubMentionSearch({
        client: fakeClient,
        scope,
        section: "pull-requests",
        debouncedQuery: props.debouncedQuery,
        filter: props.filter,
        enabled: props.enabled,
      }),
    { initialProps },
  );
}

beforeEach(() => {
  captured.enabled = null;
  captured.isError = false;
  captured.isFetching = false;
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionSearch enablement", () => {
  it("does not fire for the default filter with an empty query", () => {
    renderSearch({
      debouncedQuery: "",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });
    expect(captured.enabled).toBe(false);
  });

  it("fires for a non-empty debounced query under the default filter", () => {
    const { result } = renderSearch({
      debouncedQuery: "4917",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });
    expect(captured.enabled).toBe(true);
    // The healthy-path control for the `errored` cases below: a wanted
    // observer with no underlying error must not report one.
    expect(result.current.errored).toBe(false);
  });

  it("fires for a non-default filter even with an empty query", () => {
    renderSearch({
      debouncedQuery: "",
      filter: {
        state: "merged",
        involvement: "everyone",
        repository: null,
      },
      enabled: true,
    });
    expect(captured.enabled).toBe(true);
  });

  it("stays off when the caller has disabled the observer", () => {
    renderSearch({
      debouncedQuery: "4917",
      filter: {
        state: "merged",
        involvement: "everyone",
        repository: null,
      },
      enabled: false,
    });
    expect(captured.enabled).toBe(false);
  });
});

describe("useGithubMentionSearch errored", () => {
  it("reports a rejected search through errored", () => {
    // Retries against a rejected `mention.githubSearch` have been exhausted:
    // the query is `isError` and no longer `isFetching`.
    captured.isError = true;
    captured.isFetching = false;

    const { result } = renderSearch({
      debouncedQuery: "4917",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });

    expect(result.current.errored).toBe(true);
    expect(result.current.isSearching).toBe(false);
  });

  it("does not report a disabled observer's stale error", () => {
    // The query held onto its error from when it was live and enabled.
    captured.isError = true;

    const { result, rerender } = renderSearch({
      debouncedQuery: "4917",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });
    expect(result.current.errored).toBe(true);

    // The query clears back to the default filter with no query - exactly
    // what the catalog already answers, so this observer is no longer
    // `wanted` even though `enabled` itself stays true.
    rerender({
      debouncedQuery: "",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });

    expect(result.current.errored).toBe(false);
  });
});
