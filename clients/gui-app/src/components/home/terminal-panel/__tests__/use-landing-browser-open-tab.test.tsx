import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { BrowserTabIdentity } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  epicScope,
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

import {
  LANDING_BROWSER_TAB_CAP,
  landingBrowserCapMessage,
  landingBrowserTabCount,
  landingBrowserViewerMessage,
  useLandingBrowserOpenTab,
} from "../use-landing-browser-open-tab";

const HOST_ID = "host-a";

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

/** One independent session on `HOST_ID` holding `count` tabs. */
function independentSessionWith(count: number) {
  return sessionInfo({
    sessionId: "independent-session",
    hostId: HOST_ID,
    scope: independentScope(),
    tabs: Array.from({ length: count }, (_unused, index) =>
      tabInfo({ tabId: `tab-${index}`, url: "https://example.com/" }),
    ),
  });
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

function renderOpener(args: {
  readonly sessions: BrowserSessionsState | null;
  readonly onOpened: (tab: LandingBrowserTabRef) => void;
}) {
  return renderHook(
    () =>
      useLandingBrowserOpenTab({
        // Every scenario below is about a shell that CAN drive a tab; the one
        // that is not renders its own opener.
        canDriveTabs: true,
        hostId: HOST_ID,
        sessions: args.sessions,
        onOpened: args.onOpened,
      }),
    { wrapper: QueryWrapper },
  );
}

afterEach(() => {
  cleanup();
  mocks.toastError.mockReset();
});

describe("landingBrowserTabCount", () => {
  // The pending latch is keyed by DEVICE, so an ask on one and a later ask on
  // another are both in flight at once. A panel-level slot holding "the row
  // this answer is for" would be read by whichever device replied first,
  // whatever the other had recorded - so the association travels with its own
  // request instead.
  it("hands each answer back the request it was made with", async () => {
    const settles: Array<(identity: BrowserTabIdentity) => void> = [];
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settles.push(resolve);
        }),
    );
    const answered: Array<{
      readonly tabId: string;
      readonly placeholderInstanceId: string | null;
    }> = [];
    const hostRef: { current: string } = { current: "host-a" };
    const { result, rerender } = renderHook(
      () =>
        useLandingBrowserOpenTab({
          canDriveTabs: true,
          hostId: hostRef.current,
          sessions: sessionsState({ openTab }),
          onOpened: (tab, request) => {
            answered.push({
              tabId: tab.tabId,
              placeholderInstanceId: request.placeholderInstanceId,
            });
          },
        }),
      { wrapper: QueryWrapper },
    );

    act(() => {
      result.current.open({ placeholderInstanceId: "placeholder-a" });
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });

    // A different device, so the latch releases and a SECOND ask goes out
    // while the first is still unanswered.
    hostRef.current = "host-b";
    rerender();
    act(() => {
      result.current.open({ placeholderInstanceId: "placeholder-b" });
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(2);
    });

    // The FIRST device answers second, after the later ask recorded its own
    // row - the ordering a shared slot cannot survive.
    act(() => {
      settles[1]?.({ sessionId: "session-b", tabId: "tab-b" });
    });
    await waitFor(() => {
      expect(answered).toHaveLength(1);
    });
    act(() => {
      settles[0]?.({ sessionId: "session-a", tabId: "tab-a" });
    });
    await waitFor(() => {
      expect(answered).toHaveLength(2);
    });

    expect(answered).toEqual([
      { tabId: "tab-b", placeholderInstanceId: "placeholder-b" },
      { tabId: "tab-a", placeholderInstanceId: "placeholder-a" },
    ]);
  });

  // A shell with no native browser capability can only WATCH a tab: the tile
  // renders as a "View only" screencast, and an independent session has no
  // agent driving it either. The chord opens without ever rendering the
  // chooser's card, so the refusal has to be in the opener as well.
  it("refuses on a shell that could only watch the tab it opened", async () => {
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const onOpened = vi.fn();
    const { result } = renderHook(
      () =>
        useLandingBrowserOpenTab({
          canDriveTabs: false,
          hostId: HOST_ID,
          sessions: sessionsState({ openTab }),
          onOpened,
        }),
      { wrapper: QueryWrapper },
    );

    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        landingBrowserViewerMessage(),
      );
    });
    // The device was never asked, so no tab was left open on it.
    expect(openTab).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("has no answer before the device publishes an inventory", () => {
    expect(
      landingBrowserTabCount(
        sessionsState({ inventoryReady: false, items: [] }),
        HOST_ID,
      ),
    ).toBe(null);
    expect(landingBrowserTabCount(null, HOST_ID)).toBe(null);
    expect(landingBrowserTabCount(sessionsState({}), null)).toBe(null);
  });

  // The count answers for tabs ANOTHER window opened, which is why it is read
  // off the device's inventory rather than off the panel's own tab list.
  it("counts every independent tab this device holds, and nothing else", () => {
    const state = sessionsState({
      items: [
        independentSessionWith(2),
        // Another window's independent session on the same device still counts
        // against the cap - the host enforces it per session, and the Start
        // Page puts every panel browser on this device in one.
        sessionInfo({
          sessionId: "second-window",
          hostId: HOST_ID,
          scope: independentScope(),
          tabs: [tabInfo({ tabId: "other-1", url: "https://example.com/" })],
        }),
        // An epic-scoped session on the same device is a canvas tile, not a
        // panel tab.
        sessionInfo({
          sessionId: "epic-session",
          hostId: HOST_ID,
          scope: epicScope("epic-1"),
          tabs: [tabInfo({ tabId: "epic-1", url: "https://example.com/" })],
        }),
        // Another device entirely.
        sessionInfo({
          sessionId: "host-b-session",
          hostId: "host-b",
          scope: independentScope(),
          tabs: [tabInfo({ tabId: "b-1", url: "https://example.com/" })],
        }),
      ],
    });

    expect(landingBrowserTabCount(state, HOST_ID)).toBe(3);
  });
});

describe("useLandingBrowserOpenTab", () => {
  it("adds the ref the device answered with, never an optimistic one", async () => {
    const opened: BrowserTabIdentity = {
      sessionId: "device-minted-session",
      tabId: "device-minted-tab",
    };
    const openTab = vi.fn(() => Promise.resolve(opened));
    const onOpened = vi.fn();
    const { result } = renderOpener({
      sessions: sessionsState({ openTab }),
      onOpened,
    });

    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });
    await waitFor(() => {
      expect(onOpened).toHaveBeenCalledTimes(1);
    });

    expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    const ref = onOpened.mock.calls[0]?.[0] as LandingBrowserTabRef;
    expect(ref.kind).toBe("browser");
    expect(ref.hostId).toBe(HOST_ID);
    expect(ref.sessionId).toBe("device-minted-session");
    expect(ref.tabId).toBe("device-minted-tab");
    expect(ref.titleSource).toBe("default");
    // The default title falls back to the url while the page has no title.
    expect(ref.name).toBe("about:blank");
  });

  // One mutation per device: the chord and the chooser share the mutation key,
  // so a second ask while one is in flight is dropped rather than opening a
  // second tab the user did not ask for.
  it("opens one tab per device even when asked twice in flight", async () => {
    let settle: ((identity: BrowserTabIdentity) => void) | null = null;
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settle = resolve;
        }),
    );
    const onOpened = vi.fn();
    const { result } = renderOpener({
      sessions: sessionsState({ openTab }),
      onOpened,
    });

    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });
    await waitFor(() => {
      expect(result.current.isOpening).toBe(true);
    });
    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });
    expect(openTab).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.({ sessionId: "session-1", tabId: "tab-1" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.isOpening).toBe(false);
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  // The cap is re-checked inside the mutation and not only on the card: ⇧⌘B
  // never renders a disabled card, and the count can move between the render
  // that enabled one and the click on it.
  it("refuses at the cap with the message the chooser's card carries", async () => {
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "s", tabId: "t" }),
    );
    const { result } = renderOpener({
      sessions: sessionsState({
        items: [independentSessionWith(LANDING_BROWSER_TAB_CAP)],
        openTab,
      }),
      onOpened: vi.fn(),
    });

    expect(result.current.tabCount).toBe(LANDING_BROWSER_TAB_CAP);
    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(landingBrowserCapMessage());
    });
    expect(openTab).not.toHaveBeenCalled();
  });

  // The chooser's card is already unavailable while the count is `null`, so
  // this is the CHORD's gap: ⇧⌘B never renders that card, and a live stream
  // with no published inventory would otherwise sail past a cap check that has
  // nothing to compare against.
  it("refuses before the device has published an inventory, and says so", async () => {
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "s", tabId: "t" }),
    );
    const { result } = renderOpener({
      sessions: sessionsState({ inventoryReady: false, openTab }),
      onOpened: vi.fn(),
    });

    expect(result.current.tabCount).toBe(null);
    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Browsers are not connected yet.",
      );
    });
    // Not the cap's sentence: the device is connecting, and nothing about the
    // cap is known yet.
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      landingBrowserCapMessage(),
    );
    expect(openTab).not.toHaveBeenCalled();
  });

  // The in-flight guard above is `useIsMutating`, which is RENDERED state:
  // both calls in one tick read the value from the render they were dispatched
  // in. The chord and a click on the chooser's card can land in the same tick.
  it("opens one tab when asked twice in the SAME tick", async () => {
    let settle: ((identity: BrowserTabIdentity) => void) | null = null;
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settle = resolve;
        }),
    );
    const onOpened = vi.fn();
    const { result } = renderOpener({
      sessions: sessionsState({ openTab }),
      onOpened,
    });

    // Both calls run before any render or microtask - the same tick a chord
    // and a click can share - and the await only lets the winner's mutation
    // reach the device.
    await act(async () => {
      result.current.open({ placeholderInstanceId: null });
      result.current.open({ placeholderInstanceId: null });
      await Promise.resolve();
    });

    expect(openTab).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle?.({ sessionId: "session-1", tabId: "tab-1" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onOpened).toHaveBeenCalledTimes(1);
    });
  });

  // The latch is released when the mutation settles, so the NEXT ask opens.
  it("opens again once the device has answered", async () => {
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "s", tabId: "t" }),
    );
    const onOpened = vi.fn();
    const { result } = renderOpener({
      sessions: sessionsState({ openTab }),
      onOpened,
    });

    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });
    await waitFor(() => {
      expect(onOpened).toHaveBeenCalledTimes(1);
    });
    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(2);
    });
  });

  it("refuses before the device's stream is live", async () => {
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "s", tabId: "t" }),
    );
    const { result } = renderOpener({
      sessions: sessionsState({ lifecycle: "connecting", openTab }),
      onOpened: vi.fn(),
    });

    act(() => {
      result.current.open({ placeholderInstanceId: null });
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Browsers are not connected yet.",
      );
    });
    expect(openTab).not.toHaveBeenCalled();
  });
});
