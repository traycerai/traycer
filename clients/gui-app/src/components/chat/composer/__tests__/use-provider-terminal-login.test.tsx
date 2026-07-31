import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

const mocks = vi.hoisted(() => ({
  startTerminalLoginRequest: vi.fn(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    getActiveHostId: () => HOST_ID,
    request: mocks.startTerminalLoginRequest,
  }),
}));

import { useProviderTerminalLogin } from "@/components/chat/composer/use-provider-terminal-login";
import { hostQueryKeys } from "@/lib/query-keys";

const OLD_TERMINAL: EpicTerminalRef = {
  id: "term-old",
  instanceId: "inst-term-old",
  type: "terminal",
  name: "Copilot sign-in",
  titleSource: "manual",
  hostId: HOST_ID,
  cwd: "~",
  origin: "provider-login",
  originProviderId: "copilot",
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId={HOST_ID}>{props.children}</TabHostProvider>
    </QueryClientProvider>
  );
  return { queryClient, invalidateSpy, wrapper };
}

function renderStarter(
  viewTabId: string,
  wrapper: (props: { readonly children: ReactNode }) => ReactNode,
) {
  return renderHook(
    () =>
      useProviderTerminalLogin({
        providerId: "copilot",
        epicId: EPIC_ID,
        viewTabId,
      }),
    { wrapper },
  );
}

describe("useProviderTerminalLogin", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    nestedFocusBoundaryMock.navigateNested.mockClear();
    mocks.startTerminalLoginRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // Row 4: close-then-focus is one synchronous store sequence, and the final
  // focus lands on the NEW tile's instance, not a reused/dead one.
  it("closes the replaced tile and focuses the new one, in one sequence", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: "term-old",
    });
    const { wrapper } = makeWrapper();
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(viewTabId, OLD_TERMINAL);

    const { result } = renderStarter(viewTabId, wrapper);
    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const pane = collectPanes(canvas.root)[0];

    // The old tile is gone - not merely unfocused.
    expect(canvas.tilesByInstanceId[OLD_TERMINAL.instanceId]).toBeUndefined();

    // The active tile is a freshly opened one bound to the NEW session id.
    const activeInstanceId = pane.activeTabId;
    expect(activeInstanceId).not.toBe(OLD_TERMINAL.instanceId);
    if (activeInstanceId === null) throw new Error("expected an active tile");
    const activeTile = canvas.tilesByInstanceId[activeInstanceId];
    if (activeTile === undefined || activeTile.type !== "terminal") {
      throw new Error("expected an active terminal tile");
    }
    expect(activeTile.id).toBe("term-new");
    expect(activeTile.origin).toBe("provider-login");
  });

  // Row 5: after a successful start, `terminal.list` is invalidated so the
  // epic Terminals sidebar doesn't wait out the shared 60s staleTime.
  it("invalidates terminal.list on a successful start", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { invalidateSpy, wrapper } = makeWrapper();
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");

    const { result } = renderStarter(viewTabId, wrapper);
    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const expectedKey = hostQueryKeys.methodScope(HOST_ID, "terminal.list");
    const matched = invalidateSpy.mock.calls.some(([filters]) => {
      const key = filters?.queryKey;
      return (
        Array.isArray(key) &&
        JSON.stringify(key) === JSON.stringify(expectedKey)
      );
    });
    expect(matched).toBe(true);
  });
});
