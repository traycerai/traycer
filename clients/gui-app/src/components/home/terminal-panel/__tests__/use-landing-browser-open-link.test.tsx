import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { BrowserTabIdentity } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  useLandingPanelStore,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

import {
  LANDING_BROWSER_TAB_CAP,
  landingBrowserCapMessage,
  useLandingBrowserOpenLink,
} from "../use-landing-browser-open-tab";

const HOST_ID = "host-a";
const LANDING_PAGE_ID = "landing-1";

const RAISING_TAB: LandingBrowserTabRef = {
  kind: "browser",
  instanceId: "raising-instance",
  hostId: HOST_ID,
  sessionId: "raising-session",
  tabId: "raising-tab",
  name: "example.com",
  titleSource: "default",
};

function sessionsState(
  overrides: Partial<BrowserSessionsState>,
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab: () => Promise.reject(new Error("not used in this test")),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    ...overrides,
  };
}

function QueryWrapper(props: { readonly children: ReactNode }): ReactNode {
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

function renderOpener(sessions: BrowserSessionsState | null) {
  return renderHook(
    () =>
      useLandingBrowserOpenLink({
        browserSessions: sessions === null ? {} : { [HOST_ID]: sessions },
      }),
    { wrapper: QueryWrapper },
  );
}

/** A deferred `openTab`, so the store can move while the device is answering. */
function deferredOpenTab(): {
  readonly openTab: (
    sessionId: string | null,
    url: string,
  ) => Promise<BrowserTabIdentity>;
  readonly calls: Array<{ readonly sessionId: string | null }>;
  settle: ((identity: BrowserTabIdentity) => void) | null;
} {
  const state: {
    readonly calls: Array<{ readonly sessionId: string | null }>;
    settle: ((identity: BrowserTabIdentity) => void) | null;
    readonly openTab: (
      sessionId: string | null,
      url: string,
    ) => Promise<BrowserTabIdentity>;
  } = {
    calls: [],
    settle: null,
    openTab: (sessionId: string | null) => {
      state.calls.push({ sessionId });
      return new Promise<BrowserTabIdentity>((resolve) => {
        state.settle = resolve;
      });
    },
  };
  return state;
}

function browserTabs(): ReadonlyArray<LandingBrowserTabRef> {
  return useLandingPanelStore
    .getState()
    .tabs.filter((tab): tab is LandingBrowserTabRef => tab.kind === "browser");
}

beforeEach(() => {
  useLandingPanelStore.getState().resetForTests();
  mocks.toastError.mockReset();
});

afterEach(() => {
  cleanup();
  useLandingPanelStore.getState().resetForTests();
});

describe("useLandingBrowserOpenLink", () => {
  it("opens the popup in the raising tab's own session and activates it", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    useLandingPanelStore.getState().addTab(RAISING_TAB);

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "foreground",
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.calls).toHaveLength(1);
    });
    // The popup belongs to the SAME session as the tab that raised it.
    expect(deferred.calls[0]?.sessionId).toBe(RAISING_TAB.sessionId);

    await act(async () => {
      deferred.settle?.({ sessionId: "raising-session", tabId: "popup-tab" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    const popup = browserTabs()[1];
    expect(popup.tabId).toBe("popup-tab");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      popup.instanceId,
    );
  });

  it("leaves the reader on their row for a background open", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    useLandingPanelStore.getState().addTab(RAISING_TAB);

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "background",
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.calls).toHaveLength(1);
    });
    await act(async () => {
      deferred.settle?.({ sessionId: "raising-session", tabId: "popup-tab" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      RAISING_TAB.instanceId,
    );
  });

  // "The tab being read" is the row that is active when the popup ARRIVES, not
  // the one that was active when it was asked for. A snapshot taken before the
  // await names the latter, so a reader who moved on while the device was
  // answering gets yanked back to a row they had left.
  it("keeps the reader on the row they moved to while the device was answering", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    const store = useLandingPanelStore.getState();
    store.addTab(RAISING_TAB);
    store.addTab({
      kind: "browser",
      instanceId: "other-instance",
      hostId: HOST_ID,
      sessionId: "other-session",
      tabId: "other-tab",
      name: "other.example",
      titleSource: "default",
    });
    store.activateTab(RAISING_TAB.instanceId);

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "background",
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.calls).toHaveLength(1);
    });

    act(() => {
      useLandingPanelStore.getState().activateTab("other-instance");
    });

    await act(async () => {
      deferred.settle?.({ sessionId: "raising-session", tabId: "popup-tab" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(3);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "other-instance",
    );
  });

  // The same read also has to survive the row simply going away. This one is
  // carried by `activateTab` ignoring an id the store no longer holds, which
  // is why it is asserted rather than assumed.
  it("leaves the popup active when the row it would return to was closed mid-open", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    useLandingPanelStore.getState().addTab(RAISING_TAB);

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "background",
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.calls).toHaveLength(1);
    });

    act(() => {
      useLandingPanelStore
        .getState()
        .closeTab(LANDING_PAGE_ID, RAISING_TAB.instanceId);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(null);

    await act(async () => {
      deferred.settle?.({ sessionId: "raising-session", tabId: "popup-tab" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(1);
    });
    const popup = browserTabs()[0];
    expect(popup.tabId).toBe("popup-tab");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      popup.instanceId,
    );
  });

  // A page can emit two `window.open` calls in one tick. A single pending SLOT
  // let the second overwrite the first before either was dispatched, so one of
  // the two popups vanished with no refusal and no toast.
  it("opens both popups when a page raises two in one tick", async () => {
    const settles: Array<(identity: BrowserTabIdentity) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settles.push(resolve);
        }),
    );
    const { result } = renderOpener(sessionsState({ openTab }));
    useLandingPanelStore.getState().addTab(RAISING_TAB);

    await act(async () => {
      result.current.open(RAISING_TAB, "https://example.com/a", "foreground");
      result.current.open(RAISING_TAB, "https://example.com/b", "foreground");
      await Promise.resolve();
    });

    // One at a time on one device - the queue serialises, it does not fan out.
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      settles[0]?.({ sessionId: "raising-session", tabId: "popup-a" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      settles[1]?.({ sessionId: "raising-session", tabId: "popup-b" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(3);
    });
    expect(browserTabs().map((tab) => tab.tabId)).toEqual([
      "raising-tab",
      "popup-a",
      "popup-b",
    ]);
  });

  // Bounded, and the bound is the device's own tab cap: a ninth queued ask is
  // one the cap re-check would refuse anyway, so it is dropped rather than
  // queued behind asks that cannot land.
  it("holds no more asks than the device could ever serve", async () => {
    const settles: Array<(identity: BrowserTabIdentity) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settles.push(resolve);
        }),
    );
    const { result } = renderOpener(sessionsState({ openTab }));

    await act(async () => {
      for (let ask = 0; ask <= LANDING_BROWSER_TAB_CAP; ask += 1) {
        result.current.open(
          RAISING_TAB,
          `https://example.com/${ask}`,
          "background",
        );
      }
      await Promise.resolve();
    });

    // Drain the queue, one settle per dispatch. The loop is bounded by the cap
    // plus the ask that must NOT have been kept.
    for (let drained = 0; drained <= LANDING_BROWSER_TAB_CAP; drained += 1) {
      // `settles` grows as each settle lets the next ask dispatch, so running
      // out of them IS the queue running dry - which is the bound under test.
      if (drained >= settles.length) break;
      const settle = settles[drained];
      await act(async () => {
        settle({ sessionId: "raising-session", tabId: `popup-${drained}` });
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(LANDING_BROWSER_TAB_CAP);
    });
  });

  it("refuses at the device's cap with the same sentence the chooser carries", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({
        openTab: deferred.openTab,
        items: [
          sessionInfo({
            sessionId: "independent-session",
            hostId: HOST_ID,
            scope: independentScope(),
            tabs: Array.from(
              { length: LANDING_BROWSER_TAB_CAP },
              (_unused, index) =>
                tabInfo({ tabId: `tab-${index}`, url: "https://example.com/" }),
            ),
          }),
        ],
      }),
    );

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "foreground",
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(landingBrowserCapMessage());
    });
    expect(deferred.calls).toHaveLength(0);
    expect(browserTabs()).toHaveLength(0);
  });

  it("refuses before the device has published an inventory", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ inventoryReady: false, openTab: deferred.openTab }),
    );

    await act(async () => {
      result.current.open(
        RAISING_TAB,
        "https://example.com/next",
        "foreground",
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Browsers are not connected yet.",
      );
    });
    expect(deferred.calls).toHaveLength(0);
  });
});
