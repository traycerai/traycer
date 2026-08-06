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
  // `null` uses the fixture default (follows the host); set to drive the
  // gate's non-usable states.
  scopeStatus: null as "unreachable" | null,
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

// The panel now takes its host from the ONE sidebar picker rather than its own
// dropdown, so the scope hook is what drives these states. Derived from the
// same `state` the other host mocks use, so each test still sets one field.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () =>
      hostScopeFixture({
        host:
          state.activeHostId === null
            ? null
            : hostScopeOptionFixture({
                hostId: state.activeHostId,
                name: state.reachability.hostLabel,
              }),
        client: state.client,
        ...(state.scopeStatus === null ? {} : { status: state.scopeStatus }),
      }),
  };
});

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
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  useSettingsStore,
} from "@/stores/settings/settings-store";
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

function renderPanel(): { readonly rerender: () => void } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  // A FRESH element per (re)render — a referentially identical element lets
  // React bail out of the subtree without re-reading the mutated mocks.
  const makeUi = () => (
    <Wrapper>
      <WorktreesSettingsPanel />
    </Wrapper>
  );
  const view = render(makeUi());
  return {
    rerender: () => {
      view.rerender(makeUi());
    },
  };
}

beforeEach(() => {
  restoreOffsetHeight = installWorktreeVirtualizerOffsetHeight(() => 100_000);
  state.activeHostId = null;
  state.hosts = [];
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.client = null;
  state.scopeStatus = null;
  state.enrichment = {
    enrichedByPath: new Map(),
    erroredPaths: new Set(),
    seededPaths: new Set(),
    reportVisiblePaths: vi.fn(),
    enriching: false,
  };
  window.localStorage.clear();
  useSettingsStore.setState({
    worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
  });
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
  window.localStorage.clear();
  useSettingsStore.setState({
    worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
  });
});

function documentPosition(
  earlier: HTMLElement,
  later: HTMLElement,
): "before" | "after" | "unrelated" {
  const relation = earlier.compareDocumentPosition(later);
  if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return "before";
  if ((relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return "after";
  return "unrelated";
}

/**
 * Client-wide branch-prefix strip - must render regardless of host state.
 * Section headings ("New worktrees" / "Existing worktrees" / "Applies on every
 * host") were removed in the presentation redesign; the strip itself remains.
 */
function assertBranchPrefixStripPresent(): void {
  expect(screen.queryByText("New worktrees")).toBeNull();
  expect(screen.queryByText("Existing worktrees")).toBeNull();
  expect(screen.queryByText("Applies on every host")).toBeNull();

  const label = screen.getByText("Branch prefix");
  const scope = screen.getByText("All hosts");
  const prefixInput = screen.getByRole("textbox", { name: "Branch prefix" });
  const example = screen.getByText(/New branches start like/);

  expect(documentPosition(label, scope)).toBe("before");
  expect(documentPosition(label, prefixInput)).toBe("before");
  expect(documentPosition(label, example)).toBe("before");
}

describe("WorktreesSettingsPanel host-scoped states", () => {
  it("defers to the scope gate when no host is resolved", () => {
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = null;

    renderPanel();

    // Was "Select a host to manage its worktrees." — a flattened non-answer
    // this panel produced for every unresolved scope, including a host that
    // had just been deregistered out from under the user, and which offered
    // nothing to act on. `HostScopeGate` owns those states now: it names the
    // host, distinguishes deregistered from unroutable, and carries the way
    // back to the active host.
    expect(
      screen.queryByText("Select a host to manage its worktrees."),
    ).toBeNull();
    screen.getByTestId("host-scope-empty");
    // Branch prefix defaults are client-wide - not gated on host selection.
    assertBranchPrefixStripPresent();
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

    // Wait for the partial-listing banner specifically - not an unscoped
    // role="status", which also matches the always-mounted
    // WorktreeBranchPrefixLiveStatus region (empty when idle).
    await waitFor(() => {
      screen.getByText(/Some worktrees could not be loaded/);
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

  it("never leaves the partial-listing Retry actionable over the outage notice", async () => {
    // Pins the user-visible claim, not the mechanism. Today the banner
    // cannot outlive the disconnect at all (no client ⇒ the listing data and
    // `isPartial` drop with it), so this passes via absence; if the listing
    // cache ever learns to survive a client loss, the banner's place inside
    // the gate makes this pass via concealment instead. Either way no host
    // RPC Retry stays clickable above the unreachable notice.
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
        message: "later page failed",
        requestId: "req-partial-conceal",
        method: "worktree.listAllForHost",
        fatalDetails: null,
      });
    });

    const view = renderPanel();
    await waitFor(() => {
      screen.getByText(/Some worktrees could not be loaded/);
    });

    state.scopeStatus = "unreachable";
    state.client = null;
    view.rerender();

    screen.getByTestId("host-scope-unreachable");
    const banner = screen.queryByText(/Some worktrees could not be loaded/);
    expect(banner === null || isConcealed(banner)).toBe(true);
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

  it("renders the full toolbar without any host selector or host readout once the list is populated", async () => {
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
    // The toolbar neither picks the host nor names it: both belong to the
    // sidebar. Asserted on the host LABEL rather than on a testid - checking
    // that a testid which exists nowhere is absent proves nothing, while the
    // label is what actually reappears if a readout is ever restored here.
    expect(screen.queryByTestId("worktrees-host-select")).toBeNull();
    expect(
      screen.queryByText(state.reachability.hostLabel, {
        selector: "[data-testid='worktrees-toolbar-actions'] *",
      }),
    ).toBeNull();
    screen.getByPlaceholderText("Search repo, branch, path, PR, or Task");
    screen.getByTestId("worktrees-filter-trigger");
    screen.getByTestId("worktrees-sort-trigger");
    screen.getByRole("button", { name: "Refresh worktrees" });
    // Same branch-prefix strip as the no-host empty state - host-scoped UI
    // does not own or gate creation defaults.
    assertBranchPrefixStripPresent();
    // Prefix strip still precedes the host-scoped inventory toolbar.
    expect(
      documentPosition(
        screen.getByRole("textbox", { name: "Branch prefix" }),
        screen.getByTestId("worktrees-toolbar-actions"),
      ),
    ).toBe("before");
  });

  it("wires the store's worktreeBranchPrefix into the branch prefix input and live example", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "anurag/" });
    state.hosts = [host({ hostId: "host-a" })];
    state.activeHostId = null;

    renderPanel();

    assertBranchPrefixStripPresent();
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Branch prefix",
      }).value,
    ).toBe("anurag/");
    // Live example uses the current draft (seeded from the store) + a stable
    // per-mount suffix - don't hardcode the random slug, only the prefix.
    const example = screen.getByText(/New branches start like/);
    expect(example.textContent).toMatch(/anurag\/\S+/);
  });
});
