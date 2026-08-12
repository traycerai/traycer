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
});
