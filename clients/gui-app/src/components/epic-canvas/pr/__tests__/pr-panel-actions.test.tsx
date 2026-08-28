import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type {
  PrLightItem,
  PrSubscribeListForEpicServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import {
  MockStreamSession as SharedMockStreamSession,
  MockWsStreamClient as SharedMockWsStreamClient,
} from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { __resetPrListSubscriptionsForTesting } from "@/hooks/pr/use-pr-list-subscription";

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host1",
}));

import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";

/**
 * The list subscription is the only external boundary this component has, and
 * the shared fixture fakes exactly that - see `pr-stream-test-fixtures.ts`.
 */
type MockStreamSession =
  SharedMockStreamSession<PrSubscribeListForEpicServerFrame>;
type MockWsStreamClient =
  SharedMockWsStreamClient<PrSubscribeListForEpicServerFrame>;
// Instantiation expression: binds the shared generic class to THIS
// suite's frame type, so `new MockWsStreamClient()` needs no argument.
const MockWsStreamClient =
  SharedMockWsStreamClient<PrSubscribeListForEpicServerFrame>;

function buildPrItem(overrides: Partial<PrLightItem>): PrLightItem {
  return {
    githubHost: null,
    base: null,
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Test PR",
    baseRefName: "main",
    headRefName: "feature/test",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

describe("PrPanelActions staleness hint", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const renderActions = (props: { epicId: string; tabId: string }) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StreamRuntimeContext.Provider
            value={{ wsStreamClient: mockWsStreamClient, hostId: null }}
          >
            <PrPanelActions
              epicId={props.epicId}
              tabId={props.tabId}
              collapsed={false}
            />
          </StreamRuntimeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  };

  const emitSnapshot = async (
    epicId: string,
    items: readonly PrLightItem[],
  ): Promise<MockStreamSession> => {
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("missing list session");
    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      notice: null,
      items: [...items],
    });
    return session;
  };

  beforeEach(() => {
    // `usePrListSubscription` keeps its sessions in a MODULE-level registry,
    // which outlives both the canvas store and the query client this suite
    // already resets. Every test here happens to build a fresh
    // `MockWsStreamClient`, so no key collides today - but nothing in the
    // suite states that, and the first test that reuses a client would
    // silently inherit a live entry. Same reason
    // `pr-detail-body.test.tsx` resets its own registry on both hooks.
    __resetPrListSubscriptionsForTesting();
    resetCanvas();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    cleanup();
    __resetPrListSubscriptionsForTesting();
    resetCanvas();
    queryClient.clear();
  });

  it("says 'Not yet fetched' when the subscription has data but no PR has ever been observed", async () => {
    const epicId = "epic-never-fetched";
    renderActions({ epicId, tabId: "tab-nf" });
    // A snapshot with items whose `observedAt` is all null - the host has
    // discovered the PRs but never successfully swept any of them.
    await emitSnapshot(epicId, [buildPrItem({ observedAt: null })]);

    const hint = await screen.findByTestId("pr-panel-staleness");
    expect(hint.textContent).toBe("Not yet fetched");
  });

  it("says 'Updated …' once at least one PR carries a real observedAt", async () => {
    const epicId = "epic-fetched";
    renderActions({ epicId, tabId: "tab-f" });
    await emitSnapshot(epicId, [buildPrItem({ observedAt: 1_000 })]);

    const hint = await screen.findByTestId("pr-panel-staleness");
    await waitFor(() => {
      expect(hint.textContent).not.toBe("Not yet fetched");
    });
    expect(hint.textContent).toMatch(/^Updated /);
  });
});
