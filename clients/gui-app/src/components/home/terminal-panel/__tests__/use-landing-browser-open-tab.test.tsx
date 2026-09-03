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
      result.current.open();
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
      result.current.open();
    });
    await waitFor(() => {
      expect(result.current.isOpening).toBe(true);
    });
    act(() => {
      result.current.open();
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
      result.current.open();
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(landingBrowserCapMessage());
    });
    expect(openTab).not.toHaveBeenCalled();
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
      result.current.open();
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Browsers are not connected yet.",
      );
    });
    expect(openTab).not.toHaveBeenCalled();
  });
});
