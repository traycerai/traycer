import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  MentionGithubCatalogRequest,
  MentionGithubCatalogResponse,
} from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type { GithubMentionScope } from "@/hooks/composer/use-github-mention-catalog";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * A manual sweep pays the session's automatic follow-up.
 *
 * The follow-up effect watches the very slot `onSuccess` folds a manual
 * response into, and its ref guard used to be armed only by the AUTO lane. So
 * a catalog that was fresh at open - no follow-up owed - could have a manual
 * refresh come back `stale: true` (GitHub rate-limited, a partial sweep), and
 * the effect would immediately spend a second, automatic request re-asking
 * what the user just watched be answered.
 */

const request = vi.fn();

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1", isReady: true }),
}));

const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  request,
  requestWithSignal: request,
});

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

function answer(stale: boolean): MentionGithubCatalogResponse {
  return {
    rows: [],
    repositories: [],
    freshnessAt: 1_000,
    stale,
    sourceStatus: stale ? "cached" : "ok",
    notice: null,
  };
}

/** Recorded at the mock, typed - `request.mock.calls` is untyped `any[]`. */
const catalogRequests: Array<MentionGithubCatalogRequest> = [];

function respond(
  reply: (params: MentionGithubCatalogRequest) => MentionGithubCatalogResponse,
): void {
  request.mockImplementation(
    (
      _method: string,
      params: MentionGithubCatalogRequest,
    ): Promise<MentionGithubCatalogResponse> => {
      catalogRequests.push(params);
      return Promise.resolve(reply(params));
    },
  );
}

function autoSweeps(): Array<MentionGithubCatalogRequest> {
  return catalogRequests.filter((params) => params.refresh === "auto");
}

const REPO_A: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a"],
};
const REPO_B: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-b"],
};

function renderCatalog(initialProps: { readonly scope: GithubMentionScope }) {
  return renderHook(
    (props: { readonly scope: GithubMentionScope }) =>
      useGithubMentionCatalog({
        client,
        scope: props.scope,
        section: "pull-requests",
        enabled: true,
        allowStaleFollowUp: true,
        pickerActive: true,
      }),
    { wrapper: Wrapper, initialProps },
  );
}

beforeEach(() => {
  request.mockReset();
  catalogRequests.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionCatalog manual sweep vs the stale follow-up", () => {
  it("does not spend the follow-up on a manual response arriving stale", async () => {
    respond((params) =>
      params.refresh === "manual" ? answer(true) : answer(false),
    );
    const { result } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    // Fresh at open: nothing owed, so any auto sweep below is the defect's.
    expect(autoSweeps()).toHaveLength(0);

    await act(async () => {
      await result.current.refreshManually();
    });

    expect(autoSweeps()).toHaveLength(0);
  });

  it("still spends the follow-up on a cache that opens stale", async () => {
    // The control: the fix must not become "never follow up".
    respond(() => answer(true));
    renderCatalog({ scope: REPO_A });

    await waitFor(() => expect(autoSweeps()).toHaveLength(1));
  });

  it("keeps the follow-up owed to a DIFFERENT scope after a manual sweep", async () => {
    // The other control: a manual sweep pays for its own key only. The scope
    // the user moves to next still gets the one automatic sweep a stale cache
    // owes it.
    respond((params) => {
      if (params.refresh === "manual") return answer(true);
      return params.workspacePaths[0] === "/repo-b"
        ? answer(true)
        : answer(false);
    });
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    await act(async () => {
      await result.current.refreshManually();
    });
    expect(autoSweeps()).toHaveLength(0);

    rerender({ scope: REPO_B });

    await waitFor(() => expect(autoSweeps()).toHaveLength(1));
    expect(autoSweeps()[0]?.workspacePaths).toEqual(["/repo-b"]);
  });
});
