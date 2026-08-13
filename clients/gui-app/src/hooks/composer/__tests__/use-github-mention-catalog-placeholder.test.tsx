import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  MentionGithubCatalogRequest,
  MentionGithubCatalogResponse,
} from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type { GithubMentionScope } from "@/hooks/composer/use-github-mention-catalog";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * A scope that has not answered reads as LOADING, never as settled-empty.
 *
 * `keepPreviousData` leaves `catalogQuery.data` defined and the query in
 * `success` while the new scope's read is in flight, so a loading flag taken
 * off the query is false. The rows are withheld - they belong to the previous
 * scope - so the section had zero rows and nothing claiming to be loading, and
 * rendered the settled "no matches" copy for a scope that had said nothing.
 */

const request = vi.fn();

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1", isReady: true }),
}));

const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  request,
  requestWithSignal: request,
});

// `Wrapper` is a COMPONENT, so a bare `new QueryClient(...)` in its body mints
// a fresh one on every render - four per test here, measured - and each one
// publishes an empty cache and an empty mutation cache through the provider.
// Held in state instead, so the client is the one thing in this harness that
// does not change while the scope and the bound host do.
function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function answer(): MentionGithubCatalogResponse {
  return {
    rows: [],
    repositories: [
      { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
    ],
    freshnessAt: 1_000,
    stale: false,
    sourceStatus: "ok",
    notice: null,
  };
}

/** Answers the first scope and leaves every later one in flight. */
function answerOnly(path: string): void {
  request.mockImplementation(
    (_method: string, params: MentionGithubCatalogRequest) =>
      params.workspacePaths[0] === path
        ? Promise.resolve(answer())
        : new Promise<MentionGithubCatalogResponse>(() => {
            // The window the placeholder covers.
          }),
  );
}

const REPO_A: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a"],
};

function renderCatalog(initialProps: { readonly scope: GithubMentionScope }) {
  return renderHook(
    (props: { readonly scope: GithubMentionScope }) =>
      useGithubMentionCatalog({
        client,
        scope: props.scope,
        section: "pull-requests",
        enabled: true,
        allowStaleFollowUp: false,
        pickerActive: true,
      }),
    { wrapper: Wrapper, initialProps },
  );
}

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("useGithubMentionCatalog placeholder loading", () => {
  it("reports loading while a new scope's read is in flight", async () => {
    answerOnly("/repo-a");

    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    rerender({ scope: { epicId: "epic-1", workspacePaths: ["/repo-b"] } });

    await waitFor(() => expect(result.current.isPlaceholder).toBe(true));
    // Rows withheld AND loading true. Either one alone is a lie: rows without
    // loading is a settled empty answer this scope never gave.
    expect(result.current.rows).toEqual([]);
    expect(result.current.scopeResolved).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("does not report loading once the scope has answered", async () => {
    // The control. Without it, "loading during the placeholder window" would
    // also pass against a hook that reported loading forever.
    answerOnly("/repo-a");

    const { result } = renderCatalog({ scope: REPO_A });

    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it("reports answeredAt once the scope has answered, and withholds it while its data is a placeholder", async () => {
    // `answeredAt` is the clock `preferredScopeAnswer` compares to decide
    // which section's `repositories` to believe - it must name THIS scope's
    // arrival, never the previous scope's, or a placeholder pretending to be
    // fresh would win a tie-break it never earned.
    answerOnly("/repo-a");

    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    expect(result.current.answeredAt).not.toBeNull();
    expect(result.current.isPlaceholder).toBe(false);

    rerender({ scope: { epicId: "epic-1", workspacePaths: ["/repo-b"] } });

    await waitFor(() => expect(result.current.isPlaceholder).toBe(true));
    expect(result.current.answeredAt).toBeNull();
  });
});
