import { TestRouterProvider } from "@/__tests__/with-test-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  cleanup();
  epicHarness.teardown();
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
});
