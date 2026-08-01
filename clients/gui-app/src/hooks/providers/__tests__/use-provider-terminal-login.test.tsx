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

import { useProviderTerminalLogin } from "@/hooks/providers/use-provider-terminal-login";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  providerLoginTerminalProviderId,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";

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

interface StartTerminalLoginResult {
  readonly sessionId: string;
  readonly replacedSessionId: string | null;
}

/** A promise the test resolves by hand, so the RPC can be left in flight while
 *  the caller unmounts. Not `let resolve … | null`: the assignment happens in a
 *  callback TypeScript does not track, so the later null-check reads as always
 *  true and the value needs a cast to call. */
function deferredStartResult(): {
  readonly promise: Promise<StartTerminalLoginResult>;
  readonly resolve: (value: StartTerminalLoginResult) => void;
} {
  let settle: (value: StartTerminalLoginResult) => void = () => undefined;
  const promise = new Promise<StartTerminalLoginResult>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle(value) };
}

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
        launchedFromTile: null,
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
    useProviderLoginTerminalsStore.setState(
      useProviderLoginTerminalsStore.getInitialState(),
      true,
    );
    nestedFocusBoundaryMock.navigateNested.mockClear();
    mocks.startTerminalLoginRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // The surfaces that mount this hook (the composer banner, the ended-tile
  // restart button) can render before an epic/view tab is resolved. `start`
  // refuses there rather than firing. A regression would send `epicId: null`
  // to the host, or make it spawn a real PTY with no surface to open it into -
  // a live sign-in terminal reachable only through the Terminals sidebar.
  it.each([
    ["no epic", null, "tab-1"],
    ["no view tab", EPIC_ID, null],
  ])("start() is a no-op with %s", async (_label, epicId, viewTabId) => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useProviderTerminalLogin({
          launchedFromTile: null,
          providerId: "copilot",
          epicId,
          viewTabId,
        }),
      { wrapper },
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(mocks.startTerminalLoginRequest).not.toHaveBeenCalled();
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

  // All of the success work hangs off the MUTATION's onSuccess (passed
  // through `useProvidersStartTerminalLoginForClient`'s required `onSuccess`
  // param), not a per-`mutate` callback - TanStack drops the latter once the
  // calling component (the banner) has unmounted, which would otherwise leave
  // a live host-side sign-in terminal with no tile in front of the user and
  // no registry entry to reopen it correctly later.
  it("still opens the tile and records the registry entry after the starter unmounts before the RPC resolves", async () => {
    const pending = deferredStartResult();
    mocks.startTerminalLoginRequest.mockImplementation(() => pending.promise);
    const { wrapper } = makeWrapper();
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");

    const { result, unmount } = renderStarter(viewTabId, wrapper);
    await act(async () => {
      result.current.start();
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      pending.resolve({ sessionId: "term-new", replacedSessionId: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const pane = collectPanes(canvas.root)[0];
    const activeInstanceId = pane.activeTabId;
    if (activeInstanceId === null) throw new Error("expected an active tile");
    const activeTile = canvas.tilesByInstanceId[activeInstanceId];
    if (activeTile === undefined || activeTile.type !== "terminal") {
      throw new Error("expected an active terminal tile");
    }
    expect(activeTile.id).toBe("term-new");
    expect(activeTile.origin).toBe("provider-login");

    expect(providerLoginTerminalProviderId(HOST_ID, "term-new")).toBe(
      "copilot",
    );
  });

  // Row 4b: "Start again" on a dead sign-in tile passes its OWN tile as
  // `launchedFromTile`. After a host restart the coordinator has no
  // predecessor pointer, so it reports `replacedSessionId: null` - nothing
  // else would ever close the stale panel, and every press would add another
  // tile beside the fresh one.
  it("closes the launching tile itself when the restart reports no replaced session", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
    const closeSelf = vi.fn();

    const { result } = renderHook(
      () =>
        useProviderTerminalLogin({
          providerId: "copilot",
          epicId: EPIC_ID,
          viewTabId,
          launchedFromTile: { sessionId: "term-dead", close: closeSelf },
        }),
      { wrapper },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  // Row 4c: when the reported `replacedSessionId` IS the launching tile's own
  // session (an ordinary predecessor, not a restart), the dedicated
  // `launchedFromTile.close` must NOT also fire - that tile is already
  // retired through the replaced-session close-and-focus path, and calling
  // both would be a double-close.
  it("does not also call launchedFromTile.close when it is the reported replaced session", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: "term-dead",
    });
    const { wrapper } = makeWrapper();
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
    const closeSelf = vi.fn();

    const { result } = renderHook(
      () =>
        useProviderTerminalLogin({
          providerId: "copilot",
          epicId: EPIC_ID,
          viewTabId,
          launchedFromTile: { sessionId: "term-dead", close: closeSelf },
        }),
      { wrapper },
    );
    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(closeSelf).not.toHaveBeenCalled();
  });
});
