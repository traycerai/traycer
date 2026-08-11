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
