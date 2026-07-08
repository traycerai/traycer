import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

// `WorktreesSettingsPanel` sits above `WorktreesList` (covered exhaustively by
// `worktrees-settings-panel.test.tsx`) and owns the host-scoped states from
// core flows "Enter And Orient" / "Host And Connectivity States": no host
// selected, checking reachability, offline, not signed in, loading, error,
// and empty. None of those states are reachable through `WorktreesList`
// directly (it is only ever mounted once a host is reachable and signed in),
// so this file mocks the host-scoped hooks `WorktreesSettingsPanel` composes
// and drives each state independently.
const state = vi.hoisted(() => ({
  activeHostId: null as string | null,
  hosts: [] as HostDirectoryEntry[],
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  client: null as object | null,
  hostQuery: {
    data: undefined as
      { worktrees: readonly WorktreeHostEntryV11[] } | undefined,
    fetchStatus: "idle",
    status: "pending",
    isPending: true,
    isError: false,
    isSuccess: false,
    error: null as { message: string } | null,
    isFetching: false,
    refetch: vi.fn(() => Promise.resolve()),
  },
  enrichment: {
    enrichedByPath: new Map<string, WorktreeHostEntryV11>(),
    erroredPaths: new Set<string>(),
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

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => state.hostQuery,
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

// jsdom has no layout, so `@tanstack/react-virtual` (which sizes the scroll
// viewport and measures items via `offsetHeight`) sees zero everywhere and
// would window the populated-list scenario down to nothing. Feed it a real
// height, mirroring `worktrees-settings-panel.test.tsx`.
let offsetHeightDescriptor: PropertyDescriptor | undefined;

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

function renderPanel(): void {
  const queryClient = new QueryClient();
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
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.dataset.testid === "worktrees-virtual-scroll") return 100_000;
      if (this.hasAttribute("data-index")) return 80;
      return 0;
    },
  });
  state.activeHostId = null;
  state.hosts = [];
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.client = null;
  state.hostQuery = {
    data: undefined,
    fetchStatus: "idle",
    status: "pending",
    isPending: true,
    isError: false,
    isSuccess: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(() => Promise.resolve()),
  };
  state.enrichment = {
    enrichedByPath: new Map(),
    erroredPaths: new Set(),
    reportVisiblePaths: vi.fn(),
    enriching: false,
  };
});

afterEach(() => {
  cleanup();
  if (offsetHeightDescriptor !== undefined) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      offsetHeightDescriptor,
    );
  }
  offsetHeightDescriptor = undefined;
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
    state.client = {};
    state.hostQuery = {
      ...state.hostQuery,
      isPending: true,
      status: "pending",
    };

    renderPanel();

    screen.getByText("Loading worktrees…");
  });

  it("surfaces the query error message with a working refresh retry path", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    state.client = {};
    state.hostQuery = {
      ...state.hostQuery,
      isPending: false,
      isError: true,
      status: "error",
      error: { message: "Could not reach the worktree service." },
    };

    renderPanel();

    screen.getByText("Could not reach the worktree service.");
    const refresh = screen.getByRole("button", { name: "Refresh worktrees" });
    expect(refresh.hasAttribute("disabled")).toBe(false);
  });

  it("says nothing was created when the host's list is empty", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = "host-a";
    state.client = {};
    state.hostQuery = {
      ...state.hostQuery,
      isPending: false,
      isSuccess: true,
      status: "success",
      data: { worktrees: [] },
    };

    renderPanel();

    screen.getByText("No worktrees created on this host.");
  });

  it("renders the host select alongside the full toolbar once the list is populated", () => {
    state.hosts = [
      host({ hostId: "host-a", label: "Host A" }),
      host({ hostId: "host-b", label: "Host B" }),
    ];
    state.activeHostId = "host-a";
    state.client = {};
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
    } satisfies WorktreeHostEntryV11;
    state.hostQuery = {
      ...state.hostQuery,
      isPending: false,
      isSuccess: true,
      status: "success",
      data: { worktrees: [cleanWorktree] },
    };
    state.enrichment = {
      enrichedByPath: new Map([["/wt/clean", cleanWorktree]]),
      erroredPaths: new Set(),
      reportVisiblePaths: vi.fn(),
      enriching: false,
    };

    renderPanel();

    screen.getByTestId("worktrees-host-select");
    screen.getByPlaceholderText("Search repo, branch, path, or Task");
    screen.getByTestId("worktrees-filter-trigger");
    screen.getByTestId("worktrees-sort-trigger");
    screen.getByRole("button", { name: "Refresh worktrees" });
    screen.getByText("feat-clean");
  });
});
