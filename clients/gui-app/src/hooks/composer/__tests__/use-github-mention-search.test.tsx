import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import {
  DEFAULT_PULL_REQUEST_MENTION_FILTER,
  type GithubMentionFilter,
} from "@/lib/composer/mentions/github-mention-rows";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Captures the enablement decision `useGithubMentionSearch` hands to
 * `useHostQuery`. Searching under a default filter with an empty query is a
 * second request for the same rows the catalog already serves; non-default
 * filters and typed queries are the only cases the unary is for.
 */
const captured = vi.hoisted(() => ({
  enabled: null as boolean | null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { readonly options: { readonly enabled: boolean } }) => {
    captured.enabled = args.options.enabled;
    return {
      data: undefined,
      isFetching: false,
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

function renderSearch(input: {
  readonly debouncedQuery: string;
  readonly filter: GithubMentionFilter;
  readonly enabled: boolean;
}): void {
  renderHook(() =>
    useGithubMentionSearch({
      client: fakeClient,
      scope,
      section: "pull-requests",
      debouncedQuery: input.debouncedQuery,
      filter: input.filter,
      enabled: input.enabled,
    }),
  );
}

describe("useGithubMentionSearch enablement", () => {
  beforeEach(() => {
    captured.enabled = null;
  });

  it("does not fire for the default filter with an empty query", () => {
    renderSearch({
      debouncedQuery: "",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });
    expect(captured.enabled).toBe(false);
  });

  it("fires for a non-empty debounced query under the default filter", () => {
    renderSearch({
      debouncedQuery: "4917",
      filter: DEFAULT_PULL_REQUEST_MENTION_FILTER,
      enabled: true,
    });
    expect(captured.enabled).toBe(true);
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
