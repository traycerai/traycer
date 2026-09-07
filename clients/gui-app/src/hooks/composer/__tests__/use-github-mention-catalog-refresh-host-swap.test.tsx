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
 * A refresh rejection belongs to the host that issued it. Capture `hostId` in `onMutate` for both success and error.
 */

const request = vi.fn();
const toastSpy = vi.fn();

/** Mutable: the host swap under an in-flight request is the whole subject. */
const readiness = vi.hoisted(() => ({ hostId: "host-1", isReady: true }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: readiness.hostId,
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

// Spread the real module rather than replacing it.
vi.mock("@/lib/host-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host-error-toast")>();
  return {
    ...actual,
    toastFromHostError: (error: unknown, fallback: string) => {
      toastSpy(error, fallback);
    },
  };
});

const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  request,
  requestWithSignal: request,
});

// Held in state instead, so the client is the one thing in this harness that does not change while the scope and the bound host do.
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

/** `stale: false` so the hook's one automatic follow-up never arms. */
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

const SCOPE: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo"],
};

function renderCatalog() {
  return renderHook(
    () =>
      useGithubMentionCatalog({
        client,
        scope: SCOPE,
        section: "pull-requests",
        enabled: true,
        allowStaleFollowUp: false,
        pickerActive: true,
      }),
    { wrapper: Wrapper },
  );
}

/**
 * Answer the cache-only read immediately and hold only the manual refresh. `reject` throws if nothing is in flight so a harness ordering bug is not a timeout.
 */
function pendingManualRefresh(): {
  readonly issued: Promise<void>;
  readonly reject: (error: Error) => void;
} {
  let rejectPending: ((error: Error) => void) | null = null;
  let markIssued: () => void = () => undefined;
  const issued = new Promise<void>((resolve) => {
    markIssued = resolve;
  });
  request.mockImplementation(
    (_method: string, payload: MentionGithubCatalogRequest) => {
      if (payload.refresh !== "manual") return Promise.resolve(answer());
      return new Promise((_resolve, reject) => {
        rejectPending = reject;
        markIssued();
      });
    },
  );
  return {
    issued,
    reject: (error) => {
      if (rejectPending === null) {
        throw new Error("the manual refresh never reached the host client");
      }
      rejectPending(error);
    },
  };
}

/**
 * One controllable reject per issued refresh, keyed by call order so overlapping refreshes can fail independently.
 */
function sequentialManualRefreshes(): {
  readonly issued: (index: number) => Promise<void>;
  readonly reject: (index: number, error: Error) => void;
} {
  const issuedMarkers = new Map<number, () => void>();
  const issuedPromises = new Map<number, Promise<void>>();
  const rejectors = new Map<number, (error: Error) => void>();
  let nextIndex = 0;
  const issuedFor = (index: number): Promise<void> => {
    const existing = issuedPromises.get(index);
    if (existing !== undefined) return existing;
    const created = new Promise<void>((resolve) => {
      issuedMarkers.set(index, resolve);
    });
    issuedPromises.set(index, created);
    return created;
  };
  request.mockImplementation(
    (_method: string, payload: MentionGithubCatalogRequest) => {
      if (payload.refresh !== "manual") return Promise.resolve(answer());
      const index = nextIndex;
      nextIndex += 1;
      return new Promise<MentionGithubCatalogResponse>((_resolve, reject) => {
        rejectors.set(index, reject);
        void issuedFor(index);
        issuedMarkers.get(index)?.();
      });
    },
  );
  return {
    issued: issuedFor,
    reject: (index, error) => {
      const reject = rejectors.get(index);
      if (reject === undefined) {
        throw new Error(
          `manual refresh ${index} never reached the host client`,
        );
      }
      reject(error);
    },
  };
}

beforeEach(() => {
  readiness.hostId = "host-1";
  request.mockReset();
  toastSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionCatalog manual refresh rejection", () => {
  it("does not toast a departed host's rejection", async () => {
    const pending = pendingManualRefresh();
    const { result, rerender } = renderCatalog();

    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = result.current.refreshManually();
    });
    await act(async () => {
      await pending.issued;
    });

    // The composer rebinds while the request is still open. The hook re-renders
    // under the new host, and TanStack will call the LATEST `onError`.
    readiness.hostId = "host-2";
    rerender();

    await act(async () => {
      pending.reject(new Error("host went away"));
      await refreshed;
    });

    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("still toasts a rejection from the host that is still bound", async () => {
    // The control. Without it the fix could be "never toast", which would
    // silence the manual lane's only report that a refresh never landed.
    const pending = pendingManualRefresh();
    const { result } = renderCatalog();

    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = result.current.refreshManually();
    });
    await act(async () => {
      await pending.issued;
    });

    await act(async () => {
      pending.reject(new Error("github unreachable"));
      await refreshed;
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("toasts a rejection for the request it actually belongs to, even after a newer host's refresh replaced the mutation observer's current call", async () => {
    // The composer then rebinds back to X and X's ORIGINAL request finally rejects - a render-closure comparison would still be checking against the frozen Y and wrongly suppress the toast the now-bound X should see; the ref reads the LIVE bound host instead.
    const refreshes = sequentialManualRefreshes();
    const { result, rerender } = renderCatalog();

    let firstRefreshed: Promise<void> = Promise.resolve();
    act(() => {
      firstRefreshed = result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued(0);
    });

    // Rebind to host Y and issue a second manual refresh. This replaces the
    // observer's current mutation, freezing the first one's options at
    // whichever host is bound right now.
    readiness.hostId = "host-2";
    rerender();

    let secondRefreshed: Promise<void> = Promise.resolve();
    act(() => {
      secondRefreshed = result.current.refreshManually();
    });
    await act(async () => {
      await refreshes.issued(1);
    });

    // Rebind back to host X - the host the FIRST, still-open request was
    // actually issued against.
    readiness.hostId = "host-1";
    rerender();

    await act(async () => {
      refreshes.reject(0, new Error("host-1 unreachable"));
      await firstRefreshed;
    });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.any(Error),
      "Could not refresh from GitHub",
    );

    // Settle the second request too, so it does not leak an unhandled
    // rejection into a later test.
    await act(async () => {
      refreshes.reject(1, new Error("host-2 unreachable"));
      await secondRefreshed;
    });
  });
});
