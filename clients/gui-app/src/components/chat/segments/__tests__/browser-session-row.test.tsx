import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionReference } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";

const mocks = vi.hoisted(() => ({
  openTile: vi.fn<(intent: TileOpenIntent) => void>(),
  sessionsState: null as BrowserSessionsState | null,
  reachability: null as HostReachability | null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => EPIC_ID,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => mocks.reachability,
}));

vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  useBrowserSessionsForHost: () => mocks.sessionsState,
}));

import { BrowserSessionRow } from "@/components/chat/segments/browser-session-row";

function tab(
  overrides: Partial<BrowserTabInfo> & { tabId: string },
): BrowserTabInfo {
  return {
    url: "https://example.com/checkout",
    originTier: "external",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    boundWindowId: null,
    ...overrides,
  };
}

function sessionInfo(
  overrides: Partial<BrowserSessionInfo> & {
    sessionId: string;
    tabs: BrowserTabInfo[];
  },
): BrowserSessionInfo {
  return {
    scope: { kind: "epic", epicId: EPIC_ID },
    hostId: HOST_ID,
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 0 },
    ...overrides,
  };
}

function sessionsState(
  overrides: Partial<BrowserSessionsState>,
): BrowserSessionsState {
  return {
    viewports: {},
    setViewport: async () => {},
    reportViewport: () => {},
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 1,
    items: [],
    errorMessage: null,
    retry: () => {},
    openTab: () => Promise.reject(new Error("unused in this suite")),
    prepareOpenTab: () => {
      throw new Error("unused in this suite");
    },
    closeTab: async () => {},
    attachTab: async () => {},
    moveTab: async () => {},
    ...overrides,
  };
}

function reachability(overrides: Partial<HostReachability>): HostReachability {
  return {
    status: "reachable",
    hostLabel: "My Machine",
    unavailability: null,
    basis: "directory",
    hostKind: "local",
    ...overrides,
  };
}

function reference(
  overrides: Partial<BrowserSessionReference>,
): BrowserSessionReference {
  return {
    hostId: HOST_ID,
    sessionId: "sess-a",
    tabId: "tab-original",
    profile: "primary",
    ...overrides,
  };
}

function firstOpenIntent(): TileOpenIntent {
  const call = mocks.openTile.mock.calls.at(0);
  if (call === undefined) throw new Error("expected an openTile call");
  return call[0];
}

/**
 * The native `disabled` property, not `toBeDisabled()`: jest-dom's matchers
 * are not wired into this suite (see `fallback-tier-group-card.test.tsx`),
 * so the matcher would be undefined rather than failing informatively.
 */
function isDisabled(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.disabled;
}

describe("<BrowserSessionRow />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the exact bound host/session/tab ids when the original tab is live", () => {
    mocks.sessionsState = sessionsState({
      items: [
        sessionInfo({
          sessionId: "sess-a",
          tabs: [tab({ tabId: "tab-original", title: "Checkout" })],
        }),
      ],
    });
    mocks.reachability = reachability({});

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    const button = screen.getByRole("button", { name: /open browser/i });
    expect(isDisabled(button)).toBe(false);
    fireEvent.click(button);

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    const intent = firstOpenIntent();
    expect(intent.node).toMatchObject({
      hostId: HOST_ID,
      sessionId: "sess-a",
      tabId: "tab-original",
    });
    expect(intent.target).toEqual({ epicId: EPIC_ID });
    expect(screen.queryByText(/original tab closed/i)).toBeNull();
  });

  it("falls back to a surviving tab and marks the original tab closed", () => {
    mocks.sessionsState = sessionsState({
      items: [
        sessionInfo({
          sessionId: "sess-a",
          tabs: [tab({ tabId: "tab-survivor", title: "Dashboard" })],
        }),
      ],
    });
    mocks.reachability = reachability({});

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/original tab closed/i)).not.toBeNull();
    const button = screen.getByRole("button", { name: /open browser/i });
    expect(isDisabled(button)).toBe(false);
    fireEvent.click(button);

    expect(firstOpenIntent().node).toMatchObject({
      tabId: "tab-survivor",
    });
  });

  it("disables the row and shows Closed when every tab of the session is gone", () => {
    mocks.sessionsState = sessionsState({
      items: [sessionInfo({ sessionId: "sess-a", tabs: [] })],
    });
    mocks.reachability = reachability({});

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/· Closed/)).not.toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });

  it("shows Closing… instead of Closed while a tab is still tearing down", () => {
    mocks.sessionsState = sessionsState({
      items: [
        sessionInfo({
          sessionId: "sess-a",
          tabs: [tab({ tabId: "tab-original", status: "closing" })],
        }),
      ],
    });
    mocks.reachability = reachability({});

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/Closing…/)).not.toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });

  it("disables the row as Browser unavailable for a stale/offline inventory, never Closed", () => {
    mocks.sessionsState = sessionsState({
      lifecycle: "closed",
      inventoryReady: false,
      items: [],
    });
    mocks.reachability = reachability({});

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/Browser unavailable/)).not.toBeNull();
    expect(screen.queryByText(/· Closed/)).toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });

  it("shows Loading browser… while the inventory is still connecting on a reachable host", () => {
    mocks.sessionsState = sessionsState({
      lifecycle: "connecting",
      inventoryReady: false,
      items: [],
    });
    mocks.reachability = reachability({ status: "reachable" });

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/Loading browser…/)).not.toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });

  it("reports Browser unavailable ahead of loading when the host itself is unreachable (cold offline)", () => {
    mocks.sessionsState = sessionsState({
      lifecycle: "connecting",
      inventoryReady: false,
      items: [],
    });
    mocks.reachability = reachability({ status: "unreachable" });

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/Browser unavailable/)).not.toBeNull();
    expect(screen.queryByText(/Loading browser…/)).toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });

  it("does not use a ready inventory while the host is unreachable", () => {
    mocks.sessionsState = sessionsState({
      items: [
        sessionInfo({
          sessionId: "sess-a",
          tabs: [tab({ tabId: "tab-original", title: "Checkout" })],
        }),
      ],
    });
    mocks.reachability = reachability({ status: "unreachable" });

    render(<BrowserSessionRow session={reference({})} findUnitId="find-1" />);

    expect(screen.getByText(/Browser unavailable/)).not.toBeNull();
    expect(
      isDisabled(screen.getByRole("button", { name: /open browser/i })),
    ).toBe(true);
  });
});
