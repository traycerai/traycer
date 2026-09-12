import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { HostSessionConnectivity } from "@/lib/host/session-connectivity";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";
import {
  SURFACE_SYNC_RANK,
  useSurfaceSyncStore,
} from "@/stores/sync/surface-sync-store";
import { setMobileApp } from "@/lib/mobile-app";

interface StripMocks {
  readonly wake: Mock;
}

const mocks = vi.hoisted((): StripMocks => ({
  wake: vi.fn(),
}));

vi.mock("@/lib/host/session-connectivity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/host/session-connectivity")>(
    "@/lib/host/session-connectivity",
  )),
  useHostSessionWake: () => mocks.wake,
}));

function renderStrip(connectivity: HostSessionConnectivity): void {
  render(<SessionConnectivityStrip connectivity={connectivity} />);
}

function strip(): HTMLElement {
  return screen.getByTestId("session-connectivity-strip");
}

function bar(): HTMLElement | null {
  return screen.queryByTestId("session-connectivity-strip-bar");
}

describe("<SessionConnectivityStrip />", () => {
  // The surfaces' reports are shown only in the installed mobile app. Their
  // publishers mount on the VIEWPORT breakpoint, which a narrow desktop window
  // also satisfies, so the presentation carries the product gate instead - and
  // a suite exercising those rows has to be inside that product.
  beforeEach(() => {
    setMobileApp(true);
  });

  afterEach(() => {
    setMobileApp(false);
    cleanup();
    mocks.wake.mockReset();
    useSurfaceSyncStore.setState({ entries: {} });
  });

  function publishSurface(input: {
    readonly key: string;
    readonly rank: number;
    readonly label: string;
    readonly syncing: boolean;
    readonly escalated: boolean;
    readonly wake: (() => void) | null;
  }): void {
    act(() => {
      useSurfaceSyncStore.getState().publish(`token:${input.key}`, {
        key: input.key,
        rank: input.rank,
        label: input.label,
        spell: { syncing: input.syncing, escalated: input.escalated },
        wake: input.wake,
      });
    });
  }

  // The un-announced verdicts must render NOTHING: `settling` is inside the
  // announce window (most drops heal on the first redial), `dialing` has never
  // been ready, and `unknown` is a shell that does not announce at all. A strip
  // that painted any of them would cry wolf on every tunnel.
  for (const quiet of ["ready", "settling", "dialing", "unknown"] as const) {
    it(`renders nothing on the un-announced '${quiet}' verdict`, () => {
      renderStrip(quiet);
      expect(screen.queryByTestId("session-connectivity-strip")).toBeNull();
    });
  }

  it("says the ordinary interruption with a bar and no VISIBLE words", () => {
    // Most of what this reports heals in a second or two. A row of words that
    // appears and vanishes in that time reads as an alarm and teaches people to
    // distrust the row; the bar says "something is happening" without making a
    // sentence of it.
    renderStrip("interrupted");
    expect(bar()).not.toBeNull();
    expect(screen.queryByTestId("session-connectivity-strip-text")).toBeNull();
    expect(screen.queryByTestId("session-connectivity-strip-retry")).toBeNull();
  });

  it("puts the sentence in the live region even with nothing on screen", () => {
    // `aria-label` names the region; a live region announces what changes
    // INSIDE it. A row carrying only a label announced nothing when it
    // appeared and nothing when it escalated, which is the one update here
    // worth hearing.
    renderStrip("interrupted");
    expect(strip().textContent).toContain("Connection interrupted");
  });

  it("keeps announcing the interruption even with no words on screen", () => {
    // What a screen reader hears must not depend on whether the visual form
    // happens to spend words. The accessible name still names the CONNECTION:
    // the verdict cannot distinguish our leg down from the relay's host uplink
    // gone, so a host claim would be a guess that is wrong half the time it
    // matters.
    renderStrip("interrupted");
    expect(strip().tagName).toBe("OUTPUT");
    expect(strip().getAttribute("aria-label")).toBe(
      "Connection interrupted - reconnecting",
    );
  });

  it("keeps the calm tone in the ordinary state", () => {
    // Alarm colouring is reserved for something the user must act on. This
    // state resolves itself in a second or two, and a warning that fires on
    // every app switch is one people stop reading. Asserted as the tone it
    // MUST carry, so a swap to any other alarm palette fails here too.
    renderStrip("interrupted");
    expect(strip().className).toContain("bg-background");
    expect(strip().className).toContain("text-muted-foreground");
  });

  it("travels while the interruption is still ordinary", () => {
    renderStrip("interrupted");
    expect(bar()?.classList.contains("stream-syncing-sweep")).toBe(true);
  });

  it("spends words and offers Retry once the outage has run long", () => {
    renderStrip("interrupted-prolonged");
    expect(strip().textContent).toContain("Still reconnecting");
    expect(screen.getByTestId("session-connectivity-strip-retry")).toBeTruthy();
    // The accessible name escalates with the visible line: a static label
    // would keep announcing the first rung to a screen reader after the row
    // had moved on.
    expect(strip().getAttribute("aria-label")).toBe(
      "Connection interrupted - still reconnecting",
    );
    // Never a claim about the machine: the verdict cannot tell this device's
    // leg from the relay's host uplink, and a host is not necessarily a Mac.
    expect(strip().textContent).not.toMatch(/Mac|host|your machine/i);
    // Still calm. The escalation changes how much is said, not the palette.
    expect(strip().className).toContain("bg-background");
    expect(strip().className).toContain("text-muted-foreground");
  });

  it("stops the bar travelling once it has escalated", () => {
    // A bar still sweeping under "Still reconnecting" promises "any moment now"
    // about a retry just described as not converging - and it bounds the
    // animation of a reconnect that never converges.
    renderStrip("interrupted-prolonged");
    expect(bar()).not.toBeNull();
    expect(bar()?.classList.contains("stream-syncing-sweep")).toBe(false);
    expect(bar()?.classList.contains("w-full")).toBe(true);
  });

  it("wakes exactly the bound session when Retry is clicked, and not before", async () => {
    renderStrip("interrupted-prolonged");
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByTestId("session-connectivity-strip-retry"),
    );
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  describe("the one element", () => {
    // The whole point of moving the bar here. Three surfaces used to render
    // their own, so the indicator was a different DOM node depending on which
    // stream was speaking: every hand-off restarted the animation from its
    // first frame (always forward, so it read as repeating rather than
    // bouncing) and moved the bar down the screen by the height of whatever
    // header it sat under.
    it("keeps ONE node across the session -> epic -> chat hand-off", () => {
      const { rerender } = render(
        <SessionConnectivityStrip connectivity="interrupted" />,
      );
      publishSurface({
        key: "epic:e1",
        rank: SURFACE_SYNC_RANK.epic,
        label: "Task",
        syncing: true,
        escalated: false,
        wake: null,
      });
      publishSurface({
        key: "chat:c1",
        rank: SURFACE_SYNC_RANK.chat,
        label: "Chat",
        syncing: true,
        escalated: false,
        wake: null,
      });

      const atSession = bar();
      expect(strip().getAttribute("data-sync-source")).toBe("session");

      // The session recovers while both streams below are still restoring.
      rerender(<SessionConnectivityStrip connectivity="ready" />);
      const atEpic = bar();
      expect(strip().getAttribute("data-sync-source")).toBe("epic:e1");

      // Then the Epic's stream returns and only the chat is left.
      publishSurface({
        key: "epic:e1",
        rank: SURFACE_SYNC_RANK.epic,
        label: "Task",
        syncing: false,
        escalated: false,
        wake: null,
      });
      const atChat = bar();
      expect(strip().getAttribute("data-sync-source")).toBe("chat:c1");

      // Same DOM node throughout: nothing remounted, so nothing restarted.
      expect(atEpic).toBe(atSession);
      expect(atChat).toBe(atSession);
    });

    it("keeps the bar in one place - it is mounted here and nowhere else", () => {
      render(<SessionConnectivityStrip connectivity="interrupted" />);
      const first = strip().getBoundingClientRect();
      publishSurface({
        key: "chat:c1",
        rank: SURFACE_SYNC_RANK.chat,
        label: "Chat",
        syncing: true,
        escalated: false,
        wake: null,
      });
      expect(strip().getBoundingClientRect().top).toBe(first.top);
      expect(document.querySelectorAll("[data-testid$='-bar']").length).toBe(1);
    });

    it("lets the session leg outrank every surface below it", () => {
      // While this client's whole transport is down, every stream below it is
      // down for the same reason; naming one of them would be narrower than
      // the truth.
      publishSurface({
        key: "chat:c1",
        rank: SURFACE_SYNC_RANK.chat,
        label: "Chat",
        syncing: true,
        escalated: false,
        wake: null,
      });
      render(<SessionConnectivityStrip connectivity="interrupted" />);
      expect(strip().getAttribute("data-sync-source")).toBe("session");
    });

    it("says nothing when no surface is syncing and the session is fine", () => {
      publishSurface({
        key: "chat:c1",
        rank: SURFACE_SYNC_RANK.chat,
        label: "Chat",
        syncing: false,
        escalated: false,
        wake: null,
      });
      render(<SessionConnectivityStrip connectivity="ready" />);
      expect(screen.queryByTestId("session-connectivity-strip")).toBeNull();
    });

    it("carries the SURFACE's own words and wake once it is the one speaking", () => {
      const surfaceWake = vi.fn();
      publishSurface({
        key: "chat:c1",
        rank: SURFACE_SYNC_RANK.chat,
        label: "Chat",
        syncing: true,
        escalated: true,
        wake: surfaceWake,
      });
      render(<SessionConnectivityStrip connectivity="ready" />);
      expect(strip().textContent).toContain("Still syncing…");
      expect(strip().getAttribute("aria-label")).toBe("Chat: Still syncing…");
      screen.getByTestId("session-connectivity-strip-retry").click();
      expect(surfaceWake).toHaveBeenCalledTimes(1);
      // The app-wide wake is NOT what a surface's Retry reaches.
      expect(mocks.wake).not.toHaveBeenCalled();
    });

    it("announces the surface without showing words while it is young", () => {
      publishSurface({
        key: "epic:e1",
        rank: SURFACE_SYNC_RANK.epic,
        label: "Task",
        syncing: true,
        escalated: false,
        wake: null,
      });
      render(<SessionConnectivityStrip connectivity="ready" />);
      // No VISIBLE words - but the sentence is live content, so a reader is
      // told what is happening rather than being handed a silent bar.
      expect(
        screen.queryByTestId("session-connectivity-strip-text"),
      ).toBeNull();
      expect(strip().textContent).toBe("Task: Syncing…");
      expect(strip().getAttribute("aria-label")).toBe("Task: Syncing…");
      expect(bar()).not.toBeNull();
    });
  });
});
