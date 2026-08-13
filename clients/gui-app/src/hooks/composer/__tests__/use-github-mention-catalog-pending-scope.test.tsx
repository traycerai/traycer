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
 * "Checking" means THIS scope is being refreshed, not that something is.
 *
 * One mutation observer outlives every scope the section is rendered for, so
 * an unscoped `isPending` let a refresh issued for the old folders make the new
 * ones claim they were checking - and disable their own Refresh button until a
 * request they never issued came back.
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

function answer(): MentionGithubCatalogResponse {
  return {
    rows: [],
    repositories: [],
    freshnessAt: 1_000,
    stale: false,
    sourceStatus: "ok",
    notice: null,
  };
}

const REPO_A: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a"],
};
const REPO_B: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-b"],
};

// Two paths, one scope: an order-only difference between these two is what
// `canonicalWorkspacePaths` exists to collapse. A single-path scope can never
// exercise that - there is nothing to reorder - so the reorder test below
// needs its own pair of scopes.
const TWO_PATH_SCOPE: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a", "/repo-b"],
};
const TWO_PATH_SCOPE_REORDERED: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-b", "/repo-a"],
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

/**
 * Answers every cache-only READ and holds the manual refresh open, so the
 * scope can change while exactly one request is in flight. `issued` must be
 * awaited before asserting - `mutateAsync` does not reach `mutationFn`
 * synchronously - and the resolver THROWS if the refresh never arrived, so a
 * mis-ordered harness fails as itself rather than as a wrong verdict.
 */
function pendingManualRefresh(): { readonly issued: Promise<void> } {
  let markIssued: () => void = () => undefined;
  const issued = new Promise<void>((resolve) => {
    markIssued = resolve;
  });
  request.mockImplementation(
    (_method: string, payload: MentionGithubCatalogRequest) => {
      if (payload.refresh !== "manual") return Promise.resolve(answer());
      return new Promise<MentionGithubCatalogResponse>(() => {
        markIssued();
      });
    },
  );
  return { issued };
}

/**
 * One controllable manual refresh per workspace path, so two scopes' requests
 * can be settled in a chosen order. Reads answer immediately; only the manual
 * lane is held.
 */
function manualRefreshesByPath(): {
  readonly issued: (path: string) => Promise<void>;
  readonly settle: (path: string) => void;
} {
  const resolvers = new Map<string, () => void>();
  const issuedMarkers = new Map<string, () => void>();
  const issuedPromises = new Map<string, Promise<void>>();
  const issuedFor = (path: string): Promise<void> => {
    const existing = issuedPromises.get(path);
    if (existing !== undefined) return existing;
    const created = new Promise<void>((resolve) => {
      issuedMarkers.set(path, resolve);
    });
    issuedPromises.set(path, created);
    return created;
  };
  request.mockImplementation(
    (_method: string, payload: MentionGithubCatalogRequest) => {
      if (payload.refresh !== "manual") return Promise.resolve(answer());
      const path = payload.workspacePaths[0] ?? "";
      return new Promise<MentionGithubCatalogResponse>((resolve) => {
        resolvers.set(path, () => {
          resolve(answer());
        });
        void issuedFor(path);
        issuedMarkers.get(path)?.();
      });
    },
  );
  return {
    issued: issuedFor,
    settle: (path) => {
      const resolve = resolvers.get(path);
      if (resolve === undefined) {
        throw new Error(`no manual refresh was issued for ${path}`);
      }
      resolve();
    },
  };
}

beforeEach(() => {
  request.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionCatalog refresh pending scope", () => {
  it("does not report the new scope as checking for the old scope's refresh", async () => {
    const pending = pendingManualRefresh();
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await pending.issued;
    });
    expect(result.current.isChecking).toBe(true);

    // The folders change while that refresh is still open. The new scope never
    // asked for anything, and the observer is the same one.
    rerender({ scope: REPO_B });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    expect(result.current.isChecking).toBe(false);
  });

  it("still reports checking for the scope that issued the refresh", async () => {
    // The control. Without it the fix could be "never report checking", which
    // would take the spinner off the button the user just pressed.
    const pending = pendingManualRefresh();
    const { result } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await pending.issued;
    });

    expect(result.current.isChecking).toBe(true);
  });

  it("keeps checking when a departed scope's refresh settles first", async () => {
    // Two refreshes open at once: the scope change does not cancel the request
    // the old folders issued, and the new folders can start their own while it
    // is still running. Clearing the pending key unconditionally let whichever
    // finished FIRST clear it - so the departed scope landing early took the
    // spinner off the current scope's still-running refresh.
    const refreshes = manualRefreshesByPath();
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-a");
    });

    rerender({ scope: REPO_B });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-b");
    });
    expect(result.current.isChecking).toBe(true);

    // The DEPARTED scope's request comes back first.
    await act(async () => {
      refreshes.settle("/repo-a");
      await Promise.resolve();
    });

    expect(result.current.isChecking).toBe(true);
  });

  it("stops checking when the current scope's own refresh settles", async () => {
    // The control: the key must still be cleared by the request it belongs to,
    // or the button never re-enables.
    const refreshes = manualRefreshesByPath();
    const { result } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-a");
    });
    expect(result.current.isChecking).toBe(true);

    await act(async () => {
      refreshes.settle("/repo-a");
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
  });

  it("still reports checking after walking scope A -> B -> A while both refreshes remain unsettled", async () => {
    // `pendingRefreshKeys` is a SET, not a single latest key. A refreshes,
    // then B refreshes while A is still open, then the folders go back to A -
    // a single-key slot would have been overwritten by B's key on the way
    // through, so A's return would wrongly read as settled and its Refresh
    // button would re-enable mid-flight.
    const refreshes = manualRefreshesByPath();
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-a");
    });

    rerender({ scope: REPO_B });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-b");
    });

    // Both A and B are unsettled at this point. Walk back to A.
    rerender({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    expect(result.current.isChecking).toBe(true);
  });

  it("settling A's refresh clears only A's isChecking, leaving B's still-pending refresh reported as checking", async () => {
    // The control for the test above: the Set must remove exactly the
    // settling request's own key, not every key or none of them - otherwise
    // either scope could report the wrong spinner state once a sibling's
    // request lands.
    const refreshes = manualRefreshesByPath();
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-a");
    });

    rerender({ scope: REPO_B });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-b");
    });

    // Settle A's request while the current scope is B.
    await act(async () => {
      refreshes.settle("/repo-a");
      await Promise.resolve();
    });
    // B's own refresh is still open, so B must keep reporting checking.
    expect(result.current.isChecking).toBe(true);

    // Return to A: its key was removed by the settle above, so it must no
    // longer report checking.
    rerender({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    expect(result.current.isChecking).toBe(false);
  });

  it("still reports checking for the older scope once a newer scope's refresh settles, even though the observer's own isPending has gone false", async () => {
    // `refreshMutation.isPending` is the OBSERVER's state, and the observer
    // tracks only the LATEST `mutate()` call: once B's refresh settles it is
    // the observer's tracked mutation, so `isPending` reads false even though
    // A's refresh - issued first, replaced as the observer's "current" one by
    // B's - is still open. The old code ANDed the pending-keys set with that
    // observer flag, so the walk back to A read `isChecking` as false right
    // when the user's still-running refresh most needed to keep spinning.
    const refreshes = manualRefreshesByPath();
    const { result, rerender } = renderCatalog({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-a");
    });

    rerender({ scope: REPO_B });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued("/repo-b");
    });

    // B is the observer's latest tracked mutation. Settling it drops
    // `refreshMutation.isPending` to false while A's request is still open.
    await act(async () => {
      refreshes.settle("/repo-b");
      await Promise.resolve();
    });

    rerender({ scope: REPO_A });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    expect(result.current.isChecking).toBe(true);
  });

  it("treats a reordered folder set as the same scope's pending refresh", async () => {
    // The wire request sorts `workspacePaths` (`canonicalWorkspacePaths`), so
    // the cache-only read and the pending-refresh key it hashes must be
    // IDENTICAL for the same folder set regardless of the order the caller
    // hands it in. Unsorted, the reordered render forked a second cache slot
    // whose pending-refresh set never learned about the manual refresh the
    // first ordering had just issued - so the button's spinner vanished
    // mid-refresh purely because the caller's array order changed.
    let cacheOnlyReads = 0;
    let markManualIssued: () => void = () => undefined;
    const manualIssued = new Promise<void>((resolve) => {
      markManualIssued = resolve;
    });
    request.mockImplementation(
      (_method: string, payload: MentionGithubCatalogRequest) => {
        if (payload.refresh !== "manual") {
          cacheOnlyReads += 1;
          return Promise.resolve(answer());
        }
        return new Promise<MentionGithubCatalogResponse>(() => {
          markManualIssued();
        });
      },
    );

    const { result, rerender } = renderCatalog({ scope: TWO_PATH_SCOPE });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    act(() => {
      void result.current.refreshManually();
    });
    await act(async () => {
      await manualIssued;
    });
    expect(result.current.isChecking).toBe(true);

    const readsBeforeReorder = cacheOnlyReads;

    // Same two folders, reversed order. A scope this hook already treats as
    // canonical must resolve to the SAME query key, so the pending refresh
    // above is still remembered and no new cache-only request is needed.
    rerender({ scope: TWO_PATH_SCOPE_REORDERED });
    await waitFor(() => expect(result.current.scopeResolved).toBe(true));

    expect(result.current.isChecking).toBe(true);
    expect(cacheOnlyReads).toBe(readsBeforeReorder);
  });
});
