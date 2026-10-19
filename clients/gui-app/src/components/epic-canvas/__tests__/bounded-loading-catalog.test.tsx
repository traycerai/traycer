import { TestRouterProvider } from "@/__tests__/with-test-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HOST_STARTING_BUDGET_MS } from "@/lib/host/bounded-load-budgets";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";

/**
 * THE S1-S6 SPINNER-FOREVER CATALOG — the regression suite for the audit's
 * "Spinner-forever paths (catalogued)" table, and the acceptance artifact for
 * invariant 6 (every host-dependent loading state carries a deadline AND a
 * terminal presentation).
 *
 * Five of the six rows are pinned NEXT TO THEIR SUBJECT rather than restated
 * here, because a catalog that re-mounts six subtrees to repeat pins that
 * already live beside the code is worse coverage wearing a better name. This
 * file is the index, and it owns the one row that had no home:
 *
 * | Row | What it was | Pinned in |
 * | --- | --- | --- |
 * | S1 | epic re-point: snapshot never arrives | `providers/__tests__/epic-session-provider.test.tsx` — "bounds an authority that never attaches at the establishing deadline". Closed by P2.4's `ESTABLISHING_DEADLINE_MS`; pinned, not re-proved. |
 * | S2 | `host-starting` forever, Clone withheld | **HERE** — it needed a real `<ChatTile>` and had no existing harness that could drive reachability. |
 * | S3 | null tab client ⇒ `enabled:false` ⇒ forever `isPending` | `renderers/__tests__/published-chat-tile.test.tsx` (bounded words + `data-load-kind`, not "no spinner") |
 * | S4 | `indeterminate` ⇒ optimistic retry, no banner | `hooks/agent/__tests__/use-host-reachability.starting-deadline.test.tsx` (stays `reachable` — deliberately) + `hooks/host/__tests__/use-bounded-host-load.test.tsx` (content reaches `timed-out`) |
 * | S5 | terminal/TUI/shell-output bare skeletons | each tile's own suite: `terminal-tile-close-navigation`, `terminal-agent-tile-exit-close`, `managed-command-output-tile`, `terminal-panel/__tests__/landing-terminal-tile-bounded-load` |
 * | S6 | Clone CTA silent no-op on same host | `renderers/__tests__/use-chat-clone-on-host-switch.test.tsx` (asserts the refusal TOAST, not merely that no clone happened — "no clone happened" is also true when the button is unwired) |
 *
 * The mechanism this whole family shares was diagnosed correctly at ONE call
 * site years before it was fixed at the seam. `snapshot-diff-tile-body.tsx`
 * still carries the comment: "Use isLoading (isPending && isFetching), NOT
 * isPending: a content-less edit (both hashes null) disables the query, which
 * leaves isPending permanently true but isFetching false - that case must fall
 * through to the source-unavailable banner, not spin forever." One surface
 * defended itself; five did not. That is the argument for a shared seam.
 */

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);

// Hosts whose live session reads as ready. Empty by default, so every case
// starts with no session to any host; a case adds its host and `afterEach`
// clears it.
const readySessionHostIds = vi.hoisted(() => new Set<string>());

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-transport/remote/index")
    >()),
    hasReadyRemoteSession: (hostId: string) => readySessionHostIds.has(hostId),
  }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  getRequestContext: () => ({ userId: "user-test" }),
  onChange: () => () => undefined,
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: () => null,
};

// ENUMERATES deliberately - do NOT convert to an `importOriginal` spread.
// `@/lib/host` is a barrel of provider-coupled hooks, so the un-overridden
// residue is not inert: spreading leaks the real `useAuthService` into
// `EpicSessionProvider` -> `useStreamAuthRevalidator`, which throws "Host
// runtime hooks must be used inside a <HostRuntimeProvider>" from deep inside
// an unrelated component (~55 tests across these files). Enumeration fails the
// useful way instead: vitest names the missing export and the module.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

/**
 * The ONE seam this file drives. Everything else above is scaffolding to get a
 * `<ChatTile>` on screen; this is the input the test is actually about.
 *
 * `useHostReachability` is deliberately NOT mocked - the real hook runs, with
 * the real `useLoadDeadline` and the real `HOST_STARTING_BUDGET_MS` behind it.
 * Mocking reachability would have made this test assert that a fake returns
 * what the fake was told to return.
 */
const directoryState: {
  data: readonly HostDirectoryEntry[] | undefined;
  fetchStatus: string;
} = { data: [], fetchStatus: "success" };

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => directoryState,
}));

const EPIC_ID = "epic-bounded-loading-catalog";
const CHAT_ARTIFACT = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: "host-test",
};

function renderChatTile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TooltipProvider>
            <TestEpicSessionWrapper epicId={EPIC_ID}>
              <TabHostProvider hostId={CHAT_ARTIFACT.hostId}>
                <ChatTile
                  node={CHAT_ARTIFACT}
                  viewTabId="tab-bounded-loading"
                  tileId="pane-bounded-loading"
                  isActive
                />
              </TabHostProvider>
            </TestEpicSessionWrapper>
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>,
  );
}

const epicHarness = createEpicSessionTestHarness(EPIC_ID);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "owner-1",
      userName: "Owner",
      email: "owner@example.com",
    },
    contextMetadata: { userId: "owner-1", username: "Owner" },
  });
  epicHarness.install(null, "editor");
  directoryState.data = [];
  directoryState.fetchStatus = "success";
});

afterEach(() => {
  readySessionHostIds.clear();
  cleanup();
  epicHarness.teardown();
  useSelectionAuthorityStore.getState().reset();
  __getOpenEpicRegistryForTests().disposeAll();
  vi.useRealTimers();
});

/**
 * The epic-session harness delivers its snapshot on a `setTimeout(0)`, so the
 * gate above `<ChatTile>` opens one tick after render. Without this the whole
 * tree renders `null` and every assertion below fails for a reason that has
 * nothing to do with reachability - the empty-mount shape.
 */
async function settleEpicSession(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

/**
 * S2 — the audit's permanent trap, and F4's presentation half.
 *
 * An EMPTY host directory means this machine's own host has not published yet,
 * which the reachability hook answers `host-starting` for - correctly, because
 * a tile that called it dead would offer to fork a healthy thread. The defect
 * was that this state had NO EXIT: a chat bound to a host that never came back
 * sat behind "Waiting for the host to start…" forever, with the Clone offer -
 * the affordance that would have let the user carry on - gated on the very
 * state that never ended.
 *
 * These two tests are one claim in two halves, and BOTH halves are load-bearing:
 * withholding Clone early is what makes the state non-destructive, and offering
 * it at the deadline is what makes the state terminal.
 */
describe("S2 — host-starting is bounded, and Clone arrives AT the deadline", () => {
  it("withholds Clone while the host may still be starting", async () => {
    renderChatTile();
    await settleEpicSession();

    expect(
      screen.getByTestId(`chat-host-starting-${CHAT_ARTIFACT.id}`),
    ).not.toBeNull();
    // The whole point of the early state: cloning here would fork a thread
    // whose host is seconds from publishing.
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });

  it("falls to the unreachable banner WITH Clone once the budget elapses", async () => {
    renderChatTile();
    await settleEpicSession();
    expect(
      screen.getByTestId(`chat-host-starting-${CHAT_ARTIFACT.id}`),
    ).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS);
    });

    // The starting banner is GONE - not merely joined by a second one.
    expect(
      screen.queryByTestId(`chat-host-starting-${CHAT_ARTIFACT.id}`),
    ).toBeNull();
    expect(
      screen.getByTestId(`chat-dead-tile-${CHAT_ARTIFACT.id}`),
    ).not.toBeNull();
    // The affordance that was withheld forever.
    expect(
      screen.queryByRole("button", { name: "Clone agent" }),
    ).not.toBeNull();
  });

  // Shared-chat support, wired through the REAL container: `epic.createChat`
  // is editor-gated host-side, so a known viewer role must withhold the Clone
  // button the same banner would otherwise offer - the alternative was a
  // click that died on a bare "You don't have permission" toast. The
  // editor-role sibling above is the control: same tile, same deadline, the
  // button present.
  it("withholds Clone at the deadline for a viewer role, and says why", async () => {
    epicHarness.install(null, "viewer");
    renderChatTile();
    await settleEpicSession();

    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS);
    });

    const banner = screen.getByTestId(`chat-dead-tile-${CHAT_ARTIFACT.id}`);
    expect(banner).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    expect(banner.textContent).toContain("view-only access");
  });
});

/**
 * S2's body half (G2). Under either strip the body says what happens to THIS
 * agent and never repeats the strip, and the handle-pending wait no longer
 * ends at the shared 15 s tile budget: only the strip falls there.
 */
describe("S2 — the body under the strip", () => {
  it("says the agent will open once the host is ready, then available - never a terminal body at the 15 s budget", async () => {
    renderChatTile();
    await settleEpicSession();
    const testId = `chat-tile-pre-content-${CHAT_ARTIFACT.id}`;

    const starting = screen.getByTestId(testId);
    expect(starting.getAttribute("data-arm")).toBe("waiting-for-host");
    // The directory has no entry yet, so the only name it has is the host id,
    // and a host id is not a name: the body says "the host".
    expect(
      within(starting).getByText(
        "This agent will open once the host is ready.",
      ),
    ).not.toBeNull();
    expect(starting.textContent).not.toContain(CHAT_ARTIFACT.hostId);
    expect(starting.textContent).not.toContain("Waiting for the host to start");

    act(() => {
      vi.advanceTimersByTime(HOST_STARTING_BUDGET_MS);
    });

    const offline = screen.getByTestId(testId);
    expect(offline.getAttribute("data-arm")).toBe("waiting-for-host");
    expect(
      within(offline).getByText(
        "This agent will open once the host is available.",
      ),
    ).not.toBeNull();
    expect(offline.textContent).not.toContain(CHAT_ARTIFACT.hostId);
    expect(offline.textContent).not.toMatch(/Waiting|Loading/);
    expect(within(offline).queryByRole("button")).toBeNull();
    // Nothing is running under an offline strip with no handle.
    expect(screen.queryByTestId(`${testId}-spinner`)).toBeNull();
  });
});

/**
 * The offline strip follows the lease as well as the directory (the user
 * report: a remote host that went off sat behind a body saying it was offline
 * while nothing above it offered a way to continue). A dead-offline lease
 * mounts the Clone banner while the directory still says the host is
 * reachable, or has not answered yet; any other lease leaves the live tile
 * alone. The real reachability hook, lease hook and tile run; only the
 * directory list and the lease store are driven.
 */
describe("a dead-offline lease draws the Clone banner over a directory that has not caught up", () => {
  const bannerTestId = `chat-dead-tile-${CHAT_ARTIFACT.id}`;

  const remoteEntry: HostDirectoryEntry = {
    hostId: CHAT_ARTIFACT.hostId,
    label: "Office Mac",
    kind: "remote",
    websocketUrl: "wss://office.example.com/rpc",
    version: "1.0.0",
    transportDialability: "dialable",
  };

  const hostId = CHAT_ARTIFACT.hostId;
  const DEAD_OFFLINE: HostLeaseSnapshot = {
    hostId,
    status: "dead",
    dead: { reason: "offline" },
  };
  const DEAD_REMOVED: HostLeaseSnapshot = {
    hostId,
    status: "dead",
    dead: { reason: "removed" },
  };
  const READY: HostLeaseSnapshot = { hostId, status: "ready", dead: null };

  function publishLease(lease: HostLeaseSnapshot): void {
    useSelectionAuthorityStore.setState({ attached: true, leases: [lease] });
  }

  it("mounts the banner and its Clone button while the directory says reachable", async () => {
    directoryState.data = [remoteEntry];
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    const banner = screen.getByTestId(bannerTestId);
    expect(banner.textContent).toContain(
      'Clone this agent to continue while "Office Mac" is offline; the original stays there.',
    );
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    // The body above the strip points at the button the strip draws.
    expect(
      screen.getByTestId(`chat-tile-pre-content-${CHAT_ARTIFACT.id}`)
        .textContent,
    ).toContain(
      'Open Traycer on "Office Mac", or continue here as a new agent.',
    );
    expect(
      screen.getByTestId(`chat-tile-pre-content-${CHAT_ARTIFACT.id}`)
        .textContent,
    ).not.toContain("Turn on");
  });

  it("names the host as the host, not a raw id, while the directory is still checking", async () => {
    directoryState.data = undefined;
    directoryState.fetchStatus = "fetching";
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    const banner = screen.getByTestId(bannerTestId);
    expect(banner.textContent).toContain(
      "while the host is offline; the original stays there.",
    );
    expect(banner.textContent).not.toContain(CHAT_ARTIFACT.hostId);
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
  });

  it("names the host as the host, not its id, when the directory entry has no label", async () => {
    directoryState.data = [{ ...remoteEntry, label: "" }];
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    const banner = screen.getByTestId(bannerTestId);
    expect(banner.textContent).toContain(
      "while the host is offline; the original stays there.",
    );
    expect(banner.textContent).not.toContain(CHAT_ARTIFACT.hostId);
    const body = screen.getByTestId(
      `chat-tile-pre-content-${CHAT_ARTIFACT.id}`,
    );
    expect(body.textContent).toContain("Open Traycer on the host");
    expect(body.textContent).not.toContain(CHAT_ARTIFACT.hostId);
  });

  it("offers Clone in the banner and the body for an editor", async () => {
    epicHarness.install(null, "editor");
    directoryState.data = [remoteEntry];
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    expect(screen.getByTestId(bannerTestId)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    expect(
      screen.getByTestId(`chat-tile-pre-content-${CHAT_ARTIFACT.id}`)
        .textContent,
    ).toContain("or continue here as a new agent.");
  });

  it("withholds Clone in the banner and the body for a viewer, and says why", async () => {
    epicHarness.install(null, "viewer");
    directoryState.data = [remoteEntry];
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    expect(screen.getByTestId(bannerTestId).textContent).toContain(
      "You have view-only access to this task, so it can't be cloned.",
    );
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    const body = screen.getByTestId(
      `chat-tile-pre-content-${CHAT_ARTIFACT.id}`,
    );
    expect(body.textContent).toContain('Open Traycer on "Office Mac".');
    expect(body.textContent).not.toContain("continue here");
  });

  it("draws no banner for a ready lease on a reachable host", async () => {
    directoryState.data = [remoteEntry];
    publishLease(READY);
    renderChatTile();
    await settleEpicSession();

    expect(screen.queryByTestId(bannerTestId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });

  it("draws no banner for a removed host the directory still lists", async () => {
    directoryState.data = [remoteEntry];
    publishLease(DEAD_REMOVED);
    renderChatTile();
    await settleEpicSession();

    expect(screen.queryByTestId(bannerTestId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });

  it("draws no banner while a live session to the host is ready, whatever the lease says", async () => {
    directoryState.data = [remoteEntry];
    readySessionHostIds.add(hostId);
    publishLease(DEAD_OFFLINE);
    renderChatTile();
    await settleEpicSession();

    expect(screen.queryByTestId(bannerTestId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });
});
