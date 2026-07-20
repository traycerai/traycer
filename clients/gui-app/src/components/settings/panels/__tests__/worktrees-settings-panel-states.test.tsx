import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

// `WorktreesSettingsPanel` sits above `WorktreesList` (covered exhaustively by
// `worktrees-settings-panel.test.tsx`) and owns the host-scoped states from
// core flows "Enter And Orient" / "Host And Connectivity States": no host
// selected, checking reachability, offline, not signed in, loading, error,
// and empty. None of those states are reachable through `WorktreesList`
// directly (it is only ever mounted once a host is reachable and signed in),
// so this file mocks the host-scoped hooks `WorktreesSettingsPanel` composes
// and drives each state independently. The base listing itself
// (`useWorktreeListing`) is exercised for real against a `HostClient` bound to
// a `MockHostMessenger`, so pending/error/empty/success states go through the
// real paginated `worktree.listAllForHost` query instead of a hook mock.
const state = vi.hoisted(() => ({
  activeHostId: null as string | null,
  hosts: [] as HostDirectoryEntry[],
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  client: null as HostClient<HostRpcRegistry> | null,
  enrichment: {
    enrichedByPath: new Map<string, WorktreeHostEntryV14>(),
    erroredPaths: new Set<string>(),
    seededPaths: new Set<string>(),
    reportVisiblePaths: vi.fn(),
    enriching: false,
  },
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => state.activeHostId,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: state.hosts }),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => state.client,
}));

vi.mock("@/components/settings/panels/worktrees-enrichment", () => ({
  useWorktreeActivityEnrichment: () => state.enrichment,
}));

vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => () => ({
    wsStreamClient: {},
    close: () => {},
  }),
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ currentUserId: null, tasks: [] }),
}));

import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";
import { installWorktreeVirtualizerOffsetHeight } from "./worktrees-virtualizer-test-utils";

let restoreOffsetHeight: (() => void) | null = null;

function host(
  over: Partial<HostDirectoryEntry> & { hostId: string },
): HostDirectoryEntry {
  return {
    label: over.hostId,
    kind: "local",
    websocketUrl: null,
    version: null,
    status: "available",
    ...over,
  };
}

/**
 * Builds a real, bound `HostClient` around a single-method mock handler for
 * `worktree.listAllForHost`, so `useWorktreeListing`'s real `useInfiniteQuery`
 * + `useReactiveHostReadiness` machinery drives the panel's pending / error /
 * empty / success states instead of a hook-level mock.
 */
function clientWithHandler(
  handler: MockHandlerMap<HostRpcRegistry>["worktree.listAllForHost"],
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random()}`,
      handlers: { "worktree.listAllForHost": handler },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <Wrapper>
      <WorktreesSettingsPanel />
    </Wrapper>,
  );
}

beforeEach(() => {
  restoreOffsetHeight = installWorktreeVirtualizerOffsetHeight(() => 100_000);
  state.activeHostId = null;
  state.hosts = [];
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.client = null;
  state.enrichment = {
    enrichedByPath: new Map(),
    erroredPaths: new Set(),
    seededPaths: new Set(),
    reportVisiblePaths: vi.fn(),
    enriching: false,
  };
});

afterEach(() => {
  cleanup();
  if (restoreOffsetHeight !== null) {
    restoreOffsetHeight();
  }
  restoreOffsetHeight = null;
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

describe("WorktreesSettingsPanel host-scoped states", () => {
  it("prompts to select a host when none is selected", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = null;

    renderPanel();

    screen.getByText("Select a host to manage its worktrees.");
  });

  it("shows a reachability check while the host is being probed", () => {
    state.hosts = [host({ hostId: "host-a", label: "Host A" })];
    state.activeHostId = "host-a";
    state.reachability = { status: "checking", hostLabel: "Host A" };

    renderPanel();

    screen.getByText("Checking Host A…");
  });

  it("shows an offline message and disables refresh when the host is unreachable", () => {
    state.hosts = [host({ hostId: "host-a", label: "Host A" })];
    state.activeHostId = "host-a";
    state.reachability = { status: "unreachable", hostLabel: "Host A" };

    renderPanel();

    screen.getByText(
      "Host A is offline. Worktrees can only be managed on a reachable host.",
    );
    const refresh = screen.getByRole("button", { name: "Refresh worktrees" });
    expect(refresh.hasAttribute("disabled")).toBe(true);
  });

  it("prompts sign-in when the host is reachable but no client is bound", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    state.reachability = { status: "reachable", hostLabel: "Host A" };
    state.client = null;

    renderPanel();

    screen.getByText("Sign in to manage worktrees on this host.");
  });

  it("shows a loading state while the base listing is pending", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    // Never resolves - the base query stays pending indefinitely.
    state.client = clientWithHandler(() => new Promise(() => {}));

    renderPanel();

    screen.getByText("Loading worktrees…");
  });

  it("surfaces the query error message with a working refresh retry path", async () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    state.client = clientWithHandler(() => {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "Could not reach the worktree service.",
        requestId: "req-error",
        method: "worktree.listAllForHost",
        fatalDetails: null,
      });
    });

    renderPanel();

    await waitFor(() => {
      screen.getByText("Could not reach the worktree service.");
    });
    const refresh = screen.getByRole("button", { name: "Refresh worktrees" });
    expect(refresh.hasAttribute("disabled")).toBe(false);
  });

  it("gates the partial-listing report action on capability and reports only fixed generic context", async () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    const cleanWorktree = {
      repoLabel: "acme/app",
      repoIdentifier: { owner: "acme", repo: "app" },
      worktreePath: "/wt/clean",
      branch: "feat-clean",
      inUse: false,
      uncommittedCount: 0,
      gitRemovable: true,
      scripts: null,
      owners: [],
      lastActivityAt: null,
      branchStatus: null,
      createdAt: null,
      prState: null,
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      submodules: [],
      atBaseCommit: false,
      resolvedAt: 1,
    } satisfies WorktreeHostEntryV14;
    let call = 0;
    state.client = clientWithHandler(() => {
      call += 1;
      if (call === 1) {
        return { worktrees: [cleanWorktree], nextCursor: "cursor-2" };
      }
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "secret-token-should-never-render",
        requestId: "req-partial",
        method: "worktree.listAllForHost",
        fatalDetails: null,
      });
    });
    state.enrichment = {
      enrichedByPath: new Map([["/wt/clean", cleanWorktree]]),
      erroredPaths: new Set(),
      seededPaths: new Set(),
      reportVisiblePaths: vi.fn(),
      enriching: false,
    };

    renderPanel();

    await waitFor(() => {
      screen.getByRole("status");
    });
    // Capability-gated off by default.
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    // The report draft carries only fixed generic context - never the raw
    // host error message threaded through the banner's own visible copy.
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Some worktrees could not be loaded",
        message: null,
        code: null,
        source: "Worktrees",
      },
    });
  });

  it("says nothing was created when the host's list is empty", async () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    state.client = clientWithHandler(() => ({
      worktrees: [],
      nextCursor: null,
    }));

    renderPanel();

    await waitFor(() => {
      screen.getByText("No worktrees created on this host.");
    });
  });

  it("renders the host select alongside the full toolbar once the list is populated", async () => {
    state.hosts = [
      host({ hostId: "host-a", label: "Host A" }),
      host({ hostId: "host-b", label: "Host B" }),
    ];
    state.activeHostId = "host-a";
    const cleanWorktree = {
      repoLabel: "acme/app",
      repoIdentifier: { owner: "acme", repo: "app" },
      worktreePath: "/wt/clean",
      branch: "feat-clean",
      inUse: false,
      uncommittedCount: 0,
      gitRemovable: true,
      scripts: null,
      owners: [],
      lastActivityAt: null,
      branchStatus: null,
      createdAt: null,
      prState: null,
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      submodules: [],
      atBaseCommit: false,
      resolvedAt: 1,
    } satisfies WorktreeHostEntryV14;
    state.client = clientWithHandler(() => ({
      worktrees: [cleanWorktree],
      nextCursor: null,
    }));
    state.enrichment = {
      enrichedByPath: new Map([["/wt/clean", cleanWorktree]]),
      erroredPaths: new Set(),
      seededPaths: new Set(),
      reportVisiblePaths: vi.fn(),
      enriching: false,
    };

    renderPanel();

    await waitFor(() => {
      screen.getByText("feat-clean");
    });
    screen.getByTestId("worktrees-host-select");
    screen.getByPlaceholderText("Search repo, branch, path, PR, or Task");
    screen.getByTestId("worktrees-filter-trigger");
    screen.getByTestId("worktrees-sort-trigger");
    screen.getByRole("button", { name: "Refresh worktrees" });
  });
});
