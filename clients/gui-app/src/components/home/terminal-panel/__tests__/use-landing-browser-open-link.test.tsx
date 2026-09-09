import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { BrowserOpenedTab } from "@traycer/protocol/host/browser/contracts";
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

import type { LandingBrowserSessionEntries } from "../landing-terminal-authority-fleet";
import {
  LANDING_BROWSER_TAB_CAP,
  landingBrowserCapMessage,
  useLandingBrowserOpenLink,
  useLandingBrowserOpenTab,
  type LandingBrowserOpenLink,
  type LandingBrowserOpenRequest,
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
    connectionGeneration: 0,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab: () => Promise.reject(new Error("not used in this test")),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    moveTab: () => Promise.reject(new Error("not used in this test")),
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

/**
 * Renders the hook AND the openers it hands back, because those are what
 * dispatch the queue. A bare `renderHook` would put asks into a queue nothing
 * ever drains, and every assertion below would be about a popup that was never
 * attempted.
 */
function renderOpeners(browserSessions: LandingBrowserSessionEntries): {
  readonly result: { current: LandingBrowserOpenLink };
} {
  // Named `…Ref` because it is written during render: the react-hooks
  // immutability rule allows that only for a ref-shaped holder.
  const resultRef: { current: LandingBrowserOpenLink } = {
    current: { open: () => undefined, openers: null, pendingHostIds: [] },
  };
  function Harness(): ReactNode {
    const link = useLandingBrowserOpenLink({ browserSessions });
    // In an effect, not during render: writing an outer variable while
    // rendering is what `react-hooks/immutability` forbids. `render` is
    // act-wrapped, so this has run by the time the caller reads it.
    useEffect(() => {
      resultRef.current = link;
    }, [link]);
    return link.openers;
  }
  render(
    <QueryWrapper>
      <Harness />
    </QueryWrapper>,
  );
  return { result: resultRef };
}

function renderOpener(sessions: BrowserSessionsState | null): {
  readonly result: { current: LandingBrowserOpenLink };
} {
  return renderOpeners(sessions === null ? {} : { [HOST_ID]: sessions });
}

/** A deferred `openTab`, so the store can move while the device is answering. */
function deferredOpenTab(): {
  readonly openTab: (
    sessionId: string | null,
    url: string,
  ) => Promise<BrowserOpenedTab>;
  readonly calls: Array<{ readonly sessionId: string | null }>;
  settle: ((identity: BrowserOpenedTab) => void) | null;
} {
  const state: {
    readonly calls: Array<{ readonly sessionId: string | null }>;
    settle: ((identity: BrowserOpenedTab) => void) | null;
    readonly openTab: (
      sessionId: string | null,
      url: string,
    ) => Promise<BrowserOpenedTab>;
  } = {
    calls: [],
    settle: null,
    openTab: (sessionId: string | null) => {
      state.calls.push({ sessionId });
      return new Promise<BrowserOpenedTab>((resolve) => {
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
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
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
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
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
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
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
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
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

  // The FOREGROUND arm has the same obligation the background one does, and
  // used to have none of the protection: it landed through `addTab`, which
  // activates whatever it adds. A reader who switched rows while the device
  // was answering was pulled onto a popup they had already navigated away
  // from - the very race `fulfillPlaceholder` refuses for the direct open.
  it("does not pull the reader off the row they switched to while a foreground popup was in flight", async () => {
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
        "foreground",
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.calls).toHaveLength(1);
    });

    // The reader moves AFTER the ask went out and BEFORE the device answers.
    act(() => {
      useLandingPanelStore.getState().activateTab("other-instance");
    });

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    // The popup still lands - a tab with no row would be unreachable - it just
    // does not take a selection that is no longer the one it was asked from.
    await waitFor(() => {
      expect(browserTabs()).toHaveLength(3);
    });
    expect(browserTabs().map((tab) => tab.tabId)).toContain("popup-tab");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "other-instance",
    );
  });

  // A chooser the reader opened is a LATER choice than the popup, exactly as
  // it is for a rowless `fulfillPlaceholder` ask: taking the selection would
  // move it off the row they are looking at and orphan the unpicked row.
  it("does not take the selection from a chooser opened while a foreground popup was in flight", async () => {
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

    act(() => {
      useLandingPanelStore.getState().openPlaceholder("placeholder-1", 1);
    });

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    expect(useLandingPanelStore.getState().placeholder?.instanceId).toBe(
      "placeholder-1",
    );
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "placeholder-1",
    );
  });

  // The other half of the same rule, and the reason it is not simply "refuse
  // whenever the selection differs": closing the opener does not express a
  // preference about the popup. The store had to put the selection SOMEWHERE,
  // and a foreground popup is still what the reader asked for. The revision
  // is what makes that a fact rather than an inference - a close moves the
  // selection without touching it, so this needs no special case.
  it("still fronts a foreground popup when the row it was asked from was closed mid-open", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    const store = useLandingPanelStore.getState();
    store.addTab({
      kind: "browser",
      instanceId: "other-instance",
      hostId: HOST_ID,
      sessionId: "other-session",
      tabId: "other-tab",
      name: "other.example",
      titleSource: "default",
    });
    store.addTab(RAISING_TAB);
    store.activateTab(RAISING_TAB.instanceId);

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

    act(() => {
      useLandingPanelStore
        .getState()
        .closeTab(LANDING_PAGE_ID, RAISING_TAB.instanceId);
    });
    // The store's own fallback, not a row the reader picked.
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "other-instance",
    );

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    const popup = browserTabs().find((tab) => tab.tabId === "popup-tab");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      popup?.instanceId,
    );
  });

  // Both moves at once, which is what a row comparison cannot survive: the
  // opener goes away AND the reader then picks somewhere deliberately. The
  // opener's absence used to be read as "the store moved this, so the popup
  // may still front" - and the row the reader chose afterwards was taken.
  it("does not front a foreground popup when the reader picks a row after the opener was closed", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    const store = useLandingPanelStore.getState();
    // `fallback-instance` is what closing the opener selects; `chosen-instance`
    // is where the reader then goes. Two rows, so the two are distinguishable.
    store.addTab({
      kind: "browser",
      instanceId: "fallback-instance",
      hostId: HOST_ID,
      sessionId: "fallback-session",
      tabId: "fallback-tab",
      name: "fallback.example",
      titleSource: "default",
    });
    store.addTab({
      kind: "browser",
      instanceId: "chosen-instance",
      hostId: HOST_ID,
      sessionId: "chosen-session",
      tabId: "chosen-tab",
      name: "chosen.example",
      titleSource: "default",
    });
    store.addTab(RAISING_TAB);
    store.activateTab(RAISING_TAB.instanceId);

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

    act(() => {
      useLandingPanelStore
        .getState()
        .closeTab(LANDING_PAGE_ID, RAISING_TAB.instanceId);
      useLandingPanelStore.getState().activateTab("chosen-instance");
    });

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(3);
    });
    expect(browserTabs().map((tab) => tab.tabId)).toContain("popup-tab");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "chosen-instance",
    );
  });

  // The serialised queue's own version of the same hole. The reader navigates
  // while the FIRST popup is in flight; the second is only asked for after
  // that one settles, so anything sampled at dispatch re-baselines against the
  // row they navigated to and the second popup takes it.
  it("does not front a queued popup that was raised before the reader navigated", async () => {
    const settles: Array<(identity: BrowserOpenedTab) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserOpenedTab>((resolve) => {
          settles.push(resolve);
        }),
    );
    const { result } = renderOpener(sessionsState({ openTab }));
    const store = useLandingPanelStore.getState();
    store.addTab(RAISING_TAB);
    store.addTab({
      kind: "browser",
      instanceId: "chosen-instance",
      hostId: HOST_ID,
      sessionId: "chosen-session",
      tabId: "chosen-tab",
      name: "chosen.example",
      titleSource: "default",
    });
    store.activateTab(RAISING_TAB.instanceId);

    // Both raised by the page before the reader does anything.
    await act(async () => {
      result.current.open(RAISING_TAB, "https://example.com/a", "foreground");
      result.current.open(RAISING_TAB, "https://example.com/b", "foreground");
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useLandingPanelStore.getState().activateTab("chosen-instance");
    });

    // The first settles - correctly quiet - and only THEN is the second asked.
    await act(async () => {
      settles[0]?.({
        sessionId: "raising-session",
        tabId: "popup-a",
        handoffToken: null,
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(2);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "chosen-instance",
    );

    await act(async () => {
      settles[1]?.({
        sessionId: "raising-session",
        tabId: "popup-b",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(4);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "chosen-instance",
    );
  });

  // A CREATION is a choice too, and naming the two selection actions rather
  // than the property left this out. `claimAskedRow` returns null without
  // opening a chooser when the strip already has rows, so `app.terminal.new`
  // lands its terminal through `fulfillPlaceholder(tab, null)` - which takes
  // the selection while no chooser is up. With only `activateTab` and
  // `openPlaceholder` bumping, the revision sat still and the late popup took
  // the terminal the reader had just asked for.
  it("does not front a popup over a terminal created while it was in flight", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    const store = useLandingPanelStore.getState();
    store.addTab(RAISING_TAB);
    store.activateTab(RAISING_TAB.instanceId);

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

    // Exactly the call `addTerminalTab` makes when `claimAskedRow()` answered
    // `null`: no chooser was ever opened, so nothing in the old writer set
    // ran.
    act(() => {
      useLandingPanelStore.getState().fulfillPlaceholder(
        {
          kind: "terminal",
          instanceId: "created-terminal",
          sessionId: "created-session",
          hostId: HOST_ID,
          cwd: "/tmp",
          name: "zsh",
          titleSource: "default",
        },
        null,
      );
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "created-terminal",
    );

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "created-terminal",
    );
  });

  // The same shape through the other creation writer the enumeration turned
  // up: a provider sign-in's "Start again" lands its terminal with `addTab`,
  // which activates and never went near a chooser either.
  it("does not front a popup over a tab added by an explicit create", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderOpener(
      sessionsState({ openTab: deferred.openTab }),
    );
    const store = useLandingPanelStore.getState();
    store.addTab(RAISING_TAB);
    store.activateTab(RAISING_TAB.instanceId);

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

    act(() => {
      useLandingPanelStore.getState().addTab({
        kind: "terminal",
        instanceId: "sign-in-terminal",
        sessionId: "sign-in-session",
        hostId: HOST_ID,
        cwd: "/tmp",
        name: "Claude sign-in",
        titleSource: "manual",
        origin: "provider-login",
      });
    });

    await act(async () => {
      deferred.settle?.({
        sessionId: "raising-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(browserTabs()).toHaveLength(2);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "sign-in-terminal",
    );
  });

  // A page can emit two `window.open` calls in one tick. A single pending SLOT
  // let the second overwrite the first before either was dispatched, so one of
  // the two popups vanished with no refusal and no toast.
  it("opens both popups when a page raises two in one tick", async () => {
    const settles: Array<(identity: BrowserOpenedTab) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserOpenedTab>((resolve) => {
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
      settles[0]?.({
        sessionId: "raising-session",
        tabId: "popup-a",
        handoffToken: null,
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      settles[1]?.({
        sessionId: "raising-session",
        tabId: "popup-b",
        handoffToken: null,
      });
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
    const settles: Array<(identity: BrowserOpenedTab) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserOpenedTab>((resolve) => {
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
        settle({
          sessionId: "raising-session",
          tabId: `popup-${drained}`,
          handoffToken: null,
        });
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(LANDING_BROWSER_TAB_CAP);
    });
  });

  // Two devices, and neither waits on the other. A single pool would put host
  // B's popup behind host A's unanswered open - a device that never answers
  // would hold every other device's popups forever.
  it("opens popups on two devices at once", async () => {
    const SECOND_HOST_ID = "host-b";
    const secondTab: LandingBrowserTabRef = {
      ...RAISING_TAB,
      instanceId: "second-raising-instance",
      hostId: SECOND_HOST_ID,
      sessionId: "second-raising-session",
      tabId: "second-raising-tab",
    };
    const first = deferredOpenTab();
    const second = deferredOpenTab();
    const { result } = renderOpeners({
      [HOST_ID]: sessionsState({ openTab: first.openTab }),
      [SECOND_HOST_ID]: sessionsState({
        hostId: SECOND_HOST_ID,
        openTab: second.openTab,
      }),
    });

    await act(async () => {
      result.current.open(RAISING_TAB, "https://example.com/a", "foreground");
      result.current.open(secondTab, "https://example.com/b", "foreground");
      await Promise.resolve();
    });

    // Both devices were asked while NEITHER has answered.
    await waitFor(() => {
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(1);
    });
    expect(first.calls[0]?.sessionId).toBe("raising-session");
    expect(second.calls[0]?.sessionId).toBe("second-raising-session");
  });

  // The bound is per device too, for the same reason the queue is: the number
  // describes a device's tab ceiling, so one page filling its own device's
  // queue must not spend another device's slots.
  it("keeps one device's full queue from dropping another's popup", async () => {
    const SECOND_HOST_ID = "host-b";
    const secondTab: LandingBrowserTabRef = {
      ...RAISING_TAB,
      instanceId: "second-raising-instance",
      hostId: SECOND_HOST_ID,
      sessionId: "second-raising-session",
      tabId: "second-raising-tab",
    };
    const first = deferredOpenTab();
    const second = deferredOpenTab();
    const { result } = renderOpeners({
      [HOST_ID]: sessionsState({ openTab: first.openTab }),
      [SECOND_HOST_ID]: sessionsState({
        hostId: SECOND_HOST_ID,
        openTab: second.openTab,
      }),
    });

    await act(async () => {
      // Fill the first device's queue to its bound, and one past it.
      for (let ask = 0; ask <= LANDING_BROWSER_TAB_CAP; ask += 1) {
        result.current.open(
          RAISING_TAB,
          `https://example.com/${ask}`,
          "background",
        );
      }
      result.current.open(secondTab, "https://example.com/b", "foreground");
      await Promise.resolve();
    });

    // The second device's ask was not one of the dropped ones.
    await waitFor(() => {
      expect(second.calls).toHaveLength(1);
    });
    expect(second.calls[0]?.sessionId).toBe("second-raising-session");
  });

  // The chooser's opener and the popup queue are two senders to ONE device,
  // and each re-checks the device's tab cap against its published count. A
  // `mutationKey` groups them; it does not serialise them, so in parallel both
  // would read the count from before either opened.
  it("holds a popup until the chooser's open on that device settles", async () => {
    const chooser = deferredOpenTab();
    const popup = deferredOpenTab();
    // One state per opener, so "they serialise" cannot be an artifact of them
    // sharing a single `openTab` function.
    const chooserSessions = sessionsState({ openTab: chooser.openTab });
    const popupSessions = sessionsState({ openTab: popup.openTab });
    const resultRef: { current: LandingBrowserOpenLink } = {
      current: { open: () => undefined, openers: null, pendingHostIds: [] },
    };
    const chooserOpenRef: {
      current: (request: LandingBrowserOpenRequest) => void;
    } = { current: () => undefined };
    function Harness(): ReactNode {
      const link = useLandingBrowserOpenLink({
        browserSessions: { [HOST_ID]: popupSessions },
      });
      const direct = useLandingBrowserOpenTab({
        canDriveTabs: true,
        hostId: HOST_ID,
        browserSessions: { [HOST_ID]: chooserSessions },
        onOpened: () => undefined,
      });
      useEffect(() => {
        resultRef.current = link;
        chooserOpenRef.current = direct.open;
      }, [direct.open, link]);
      return link.openers;
    }
    render(
      <QueryWrapper>
        <Harness />
      </QueryWrapper>,
    );

    await act(async () => {
      chooserOpenRef.current({ placeholderInstanceId: null });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(chooser.calls).toHaveLength(1);
    });

    await act(async () => {
      resultRef.current.open(
        RAISING_TAB,
        "https://example.com/a",
        "foreground",
      );
      await Promise.resolve();
    });

    // Queued and dispatched, but the device has NOT been asked: the shared
    // scope is holding it behind the chooser's open.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(popup.calls).toHaveLength(0);

    await act(async () => {
      chooser.settle?.({
        sessionId: "chooser-session",
        tabId: "chooser-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    // Released once the first settled, so its cap re-check reads a count that
    // includes the tab the chooser just opened.
    await waitFor(() => {
      expect(popup.calls).toHaveLength(1);
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
