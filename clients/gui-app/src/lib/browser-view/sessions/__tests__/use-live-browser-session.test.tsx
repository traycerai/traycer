import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { useLiveBrowserSession } from "@/lib/browser-view/sessions/use-live-browser-session";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

/**
 * The registry stands in, but its SUBSCRIBE is real: listeners are held and
 * fired, so `useSyncExternalStore` re-reads the snapshot exactly as it does
 * against the live coordinators. That is what makes the memo observable - a
 * mocked no-op subscribe never re-reads, so any memo would look correct.
 */
const registry = vi.hoisted(() => ({
  session: null as BrowserSessionInfo | null,
  listeners: new Set<() => void>(),
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  browserSessionAcrossCoordinators: () => registry.session,
  subscribeToBrowserSessionsCoordinators: (listener: () => void) => {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
}));

function emit(): void {
  act(() => {
    for (const listener of [...registry.listeners]) listener();
  });
}

function tab(overrides: Partial<BrowserTabInfo>): BrowserTabInfo {
  return tabInfo({
    tabId: "tab-1",
    title: "Login",
    url: "https://example.test/login",
    originTier: "external",
    status: "ready",
    ...overrides,
  });
}

/**
 * A fresh session object every call - the host mints one per frame, bumping
 * `lastActivityAt`, which is exactly the churn the content key exists to
 * absorb.
 */
function session(input: {
  readonly lastActivityAt: number;
  readonly tabs: readonly BrowserTabInfo[];
}): BrowserSessionInfo {
  return sessionInfo({
    profile: "isolated",
    lastActivityAt: input.lastActivityAt,
    tabs: [...input.tabs],
  });
}

const seen: Array<BrowserSessionInfo | null> = [];

function Probe() {
  const live = useLiveBrowserSession("session-1");
  seen.push(live);
  return (
    <div data-testid="live-probe" data-status={live?.tabs[0]?.status ?? ""} />
  );
}

beforeEach(() => {
  seen.length = 0;
  registry.listeners.clear();
  registry.session = session({ lastActivityAt: 1, tabs: [tab({})] });
});

afterEach(cleanup);

describe("useLiveBrowserSession", () => {
  it("keeps one reference across a frame that changes nothing mention-relevant", () => {
    // Mutation: dropping the content-key cache and returning the raw session -
    // the host bumps `lastActivityAt` on essentially every frame, so every
    // mention chip would re-render at frame rate.
    render(<Probe />);
    const first = seen.at(-1);
    expect(first).not.toBeNull();

    registry.session = session({ lastActivityAt: 2, tabs: [tab({})] });
    emit();

    expect(seen.at(-1)).not.toBeNull();
    expect(Object.is(seen.at(-1), first)).toBe(true);
  });

  it("returns a new reference when a tab's status changes", () => {
    // Mutation: dropping `status` from the content key - an annotation card
    // reading staleness off it would never notice a tab going dormant.
    render(<Probe />);
    const first = seen.at(-1);

    registry.session = session({
      lastActivityAt: 3,
      tabs: [tab({ status: "dormant" })],
    });
    emit();

    expect(Object.is(seen.at(-1), first)).toBe(false);
    expect(screen.getByTestId("live-probe").dataset.status).toBe("dormant");
  });
});
