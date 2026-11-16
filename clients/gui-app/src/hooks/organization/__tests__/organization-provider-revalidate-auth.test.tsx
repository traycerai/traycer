import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * The organization provider's account-wide subscription (empty task ids)
 * receives the pool's `historyInvalidation` token on every membership
 * change, and calls `AuthService.revalidateCurrentContextAfterInvalidation()`
 * whenever that token changes for the current account - never for a
 * task-chunk's own token, never on first load, and never as a stale diff
 * carried over from a previous host/account scope. Dedupe of overlapping
 * calls is `AuthService`'s own job, not the provider's: the provider calls
 * once per observed change (see
 * `organization-provider-revalidate-auth-real-service.test.tsx` for the real
 * `AuthService` coalescing contract and the pushed-frame -> toast path).
 */

interface FakeAuthService {
  readonly revalidateCurrentContextAfterInvalidation: () => Promise<null>;
}

const state = vi.hoisted(() => {
  const identity: { hostId: string; userId: string } = {
    hostId: "host-1",
    userId: "user-1",
  };
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
  };
  const support: { current: boolean | null } = { current: true };
  const mutateAsync = vi.fn();
  const authService: { current: FakeAuthService | null } = { current: null };
  // The account-wide subscription's own view (empty task ids) and, once a
  // task is open, the task-chunk subscription's view - the two the design
  // requires the provider to tell apart.
  let accountView: OrganizationView;
  let chunkView: OrganizationView;
  return {
    client,
    identity,
    support,
    mutateAsync,
    authService,
    get accountView() {
      return accountView;
    },
    set accountView(value: OrganizationView) {
      accountView = value;
    },
    get chunkView() {
      return chunkView;
    },
    set chunkView(value: OrganizationView) {
      chunkView = value;
    },
  };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
  useAuthService: () => state.authService.current,
}));

vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: <T,>(client: T): T => client,
  usePoolTierStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: state.identity.hostId,
    requestContextUserId: state.identity.userId,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.support.current,
  useHostSupportsMethod: () => state.support.current === true,
}));

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly method: string;
    readonly params: { readonly taskIds: readonly string[] };
  }) => {
    if (args.method === "organization.refresh") {
      const data =
        args.params.taskIds.length === 0 ? state.accountView : state.chunkView;
      return { data, isFetchedAfterMount: true, isSuccess: true };
    }
    // The top-level merged "organization.read" query: not what the new
    // behavior watches, so a stable ready answer keeps the provider's other
    // effects (history invalidation, failures) harmless no-ops here.
    return {
      data: state.accountView,
      isFetchedAfterMount: true,
      isSuccess: true,
    };
  },
  useHostMutation: () => ({ mutateAsync: state.mutateAsync }),
}));

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

function emptyView(historyInvalidation: string | undefined): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
    ...(historyInvalidation !== undefined ? { historyInvalidation } : {}),
  };
}

function renderProvider(queryClient: QueryClient): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>{null}</OrganizationProvider>
    </QueryClientProvider>,
  );
}

function rerenderProvider(
  rendered: RenderResult,
  queryClient: QueryClient,
): void {
  act(() => {
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>{null}</OrganizationProvider>
      </QueryClientProvider>,
    );
  });
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
    shareableTeams: [
      { teamId: "team-a", slug: "team-a-slug", avatarUrl: null },
    ],
  });
}

/**
 * `useMutation`'s `mutate()` registers a `Mutation` in the client's
 * mutation cache synchronously, before the mutation function itself ever
 * runs - so an empty cache right after a render/rerender (both already
 * `act`-wrapped, which flushes the synchronous callback that would have
 * called `mutate`) proves `mutate` was never invoked at all, not merely that
 * its result has not landed yet. That is a stronger, zero-wait witness for
 * "never calls revalidateCurrentContextAfterInvalidation" than waiting on
 * the fake implementation's own call count.
 */
function mutationCacheSize(queryClient: QueryClient): number {
  return queryClient.getMutationCache().getAll().length;
}

beforeEach(() => {
  state.identity.hostId = "host-1";
  state.identity.userId = "user-1";
  state.support.current = true;
  state.mutateAsync.mockReset();
  state.accountView = emptyView("token-1");
  state.chunkView = emptyView("chunk-token-1");
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  signIn("user-1");
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    shareableTeams: [],
  });
});

describe("OrganizationProvider revalidates auth on membership-changing tokens", () => {
  it("never calls revalidateCurrentContextAfterInvalidation on first load, however the first token reads", () => {
    const revalidateCurrentContextAfterInvalidation = vi.fn(() =>
      Promise.resolve(null),
    );
    state.authService.current = { revalidateCurrentContextAfterInvalidation };
    const queryClient = new QueryClient();

    renderProvider(queryClient);

    expect(mutationCacheSize(queryClient)).toBe(0);
    expect(revalidateCurrentContextAfterInvalidation).not.toHaveBeenCalled();
  });

  it("never calls revalidateCurrentContextAfterInvalidation for a task-chunk's own token change", () => {
    const revalidateCurrentContextAfterInvalidation = vi.fn(() =>
      Promise.resolve(null),
    );
    state.authService.current = { revalidateCurrentContextAfterInvalidation };
    useEpicCanvasStore.getState().openEpicTab("task-1", "task-1");
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient);

    state.chunkView = emptyView("chunk-token-2");
    rerenderProvider(rendered, queryClient);

    expect(mutationCacheSize(queryClient)).toBe(0);
    expect(revalidateCurrentContextAfterInvalidation).not.toHaveBeenCalled();
  });

  it("calls again for a second account-wide token change with no dedupe at this layer, even while the first call has not settled", async () => {
    let settleFirst: () => void = () => undefined;
    const revalidateCurrentContextAfterInvalidation = vi
      .fn<() => Promise<null>>()
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            settleFirst = () => resolve(null);
          }),
      )
      .mockImplementation(() => Promise.resolve(null));
    state.authService.current = { revalidateCurrentContextAfterInvalidation };
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient);

    state.accountView = emptyView("token-2");
    rerenderProvider(rendered, queryClient);
    await waitFor(() =>
      expect(revalidateCurrentContextAfterInvalidation).toHaveBeenCalledTimes(
        1,
      ),
    );

    // A second change lands while the first call has not settled. The
    // provider is not the single-flight authority - that is
    // `AuthService.revalidateCurrentContextAfterInvalidation`'s own job - so
    // it makes its own call for its own observed change regardless.
    state.accountView = emptyView("token-3");
    rerenderProvider(rendered, queryClient);
    await waitFor(() =>
      expect(revalidateCurrentContextAfterInvalidation).toHaveBeenCalledTimes(
        2,
      ),
    );

    // Nothing downstream of the mutation reacts to its own resolution; settle
    // it only so the test leaves no pending promise behind.
    act(() => settleFirst());
  });

  it("treats a new account's first account-wide view as a first load, not a diff against the old account's token", async () => {
    const revalidateCurrentContextAfterInvalidation = vi.fn(() =>
      Promise.resolve(null),
    );
    state.authService.current = { revalidateCurrentContextAfterInvalidation };
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient);

    state.accountView = emptyView("token-2");
    rerenderProvider(rendered, queryClient);
    await waitFor(() =>
      expect(revalidateCurrentContextAfterInvalidation).toHaveBeenCalledTimes(
        1,
      ),
    );
    revalidateCurrentContextAfterInvalidation.mockClear();
    const cacheSizeBeforeScopeSwitch = mutationCacheSize(queryClient);

    // Switch host/account scope. The new scope's own first observed token
    // ("token-from-b") differs from the old scope's last token
    // ("token-2"), but nothing has been observed for this scope before.
    state.identity.hostId = "host-2";
    state.identity.userId = "user-2";
    signIn("user-2");
    state.accountView = emptyView("token-from-b");
    rerenderProvider(rendered, queryClient);

    expect(mutationCacheSize(queryClient)).toBe(cacheSizeBeforeScopeSwitch);
    expect(revalidateCurrentContextAfterInvalidation).not.toHaveBeenCalled();
  });
});
