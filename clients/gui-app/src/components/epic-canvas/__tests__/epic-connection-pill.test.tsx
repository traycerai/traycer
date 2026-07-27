import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";

const mocks = vi.hoisted(() => ({
  useEpicSyncPillState: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSyncPillState: mocks.useEpicSyncPillState,
}));

const OFFLINE_COPY =
  "Disconnected. Unsent changes stay in this window until it reconnects — keep it open.";
const SYNCING_TOOLTIP = "Some changes have not reached the cloud yet.";

function pillTree() {
  return (
    <TooltipProvider>
      <EpicConnectionPill />
    </TooltipProvider>
  );
}

function renderPill(state: EpicSyncPillState) {
  mocks.useEpicSyncPillState.mockReturnValue(state);
  return render(pillTree());
}

/**
 * Reads the claim off the pill's accessible name. Uses `getByRole` rather
 * than `queryByTestId` deliberately: a missing pill must FAIL these
 * assertions, not silently satisfy the negative ones - a rendering
 * regression would otherwise read as "does not claim synced".
 */
function pillClaimsSynced(): boolean {
  return (
    screen.getByRole("button").getAttribute("aria-label") ===
    "All changes synced"
  );
}

async function expectTooltip(text: string) {
  fireEvent.focus(screen.getByTestId("epic-connection-pill"));
  expect((await screen.findByRole("tooltip")).textContent).toBe(text);
}

describe("<EpicConnectionPill />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("renders the synced state icon-only with the claim on the accessible name", () => {
    vi.useFakeTimers();
    renderPill("synced");

    act(() => {
      vi.advanceTimersByTime(750);
    });

    // Icon-only in the steady state: the claim moved off the visible copy and
    // onto the accessible name + tooltip, so the status row stays compact.
    expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("aria-label"),
    ).toBe("All changes synced");
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "italic",
    );
    expect(screen.getByTestId("epic-connection-pill").innerHTML).toContain(
      "bg-emerald-500",
    );
    expect(screen.getByTestId("epic-connection-pill").innerHTML).toContain(
      "animate-ping",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("synced");
    // The tooltip carries the same claim; it is asserted in the real-timer
    // test below (a fake-timer clock cannot settle `findByRole`).
    expect(pillClaimsSynced()).toBe(true);
  });

  // Real timers: the icon-only steady state must still expose its claim to a
  // sighted user, and the tooltip is now the only place that copy lives.
  it("surfaces the synced claim through the tooltip", async () => {
    renderPill("synced");

    await expectTooltip("All changes synced");
  });

  it("renders connecting as the amber bootstrap pill with no tooltip", () => {
    renderPill("connecting");

    expect(screen.getByText("Connecting…")).not.toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-amber-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "text-amber-500",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("connecting");
    fireEvent.focus(screen.getByTestId("epic-connection-pill"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders reconnecting as the amber pill with no tooltip", () => {
    renderPill("reconnecting");

    expect(screen.getByText("Reconnecting…")).not.toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-amber-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "text-amber-500",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("reconnecting");
    fireEvent.focus(screen.getByTestId("epic-connection-pill"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders the offline state as a red pill with disconnect tooltip text", async () => {
    renderPill("offline");

    expect(screen.getByText("Offline")).not.toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-red-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-red-500",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("offline");
    await expectTooltip(OFFLINE_COPY);
  });

  // `offline` is the ONE state where an unsent edit exists only in this
  // window's memory, so it is the one state that must not promise the edit is
  // safe. Both surfaces are pinned: the tooltip a sighted user hovers and the
  // aria-label a screen-reader user hears.
  it("offline promises nothing about durability in either the tooltip or the aria-label", async () => {
    renderPill("offline");

    const label = screen
      .getByTestId("epic-connection-pill")
      .getAttribute("aria-label");
    expect(label).toBe(OFFLINE_COPY);
    expect(label).not.toContain("will sync");
    await expectTooltip(OFFLINE_COPY);
  });

  it("renders syncing with the Syncing… label, never claims synced, and shows no emerald pulse", async () => {
    renderPill("syncing");

    expect(screen.getByText("Syncing…")).not.toBeNull();
    expect(pillClaimsSynced()).toBe(false);
    expect(screen.getByTestId("epic-connection-pill").innerHTML).not.toContain(
      "animate-ping",
    );
    expect(screen.getByTestId("epic-connection-pill").innerHTML).not.toContain(
      "bg-emerald-500",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("syncing");
    await expectTooltip(SYNCING_TOOLTIP);
  });

  it("renders neutral Connected without a synced or durability assertion", () => {
    renderPill("connected");

    expect(screen.getByText("Connected")).not.toBeNull();
    expect(pillClaimsSynced()).toBe(false);
    expect(
      screen.getByTestId("epic-connection-pill").textContent,
    ).not.toContain("saved locally");
    expect(screen.getByTestId("epic-connection-pill").innerHTML).not.toContain(
      "animate-ping",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("connected");
  });

  it("renders offlineChangesSavedLocally with its label, tooltip, and no spinner", async () => {
    renderPill("offlineChangesSavedLocally");

    expect(screen.getByText("Offline — changes saved locally")).not.toBeNull();
    // The spinner (AgentSpinningDots) writes a braille glyph into the dot's
    // textContent via layout effect; the plain-dot fallback renders no
    // children at all. An empty dot is the behavioral signal that no
    // spinner mounted, matching `showAgentSpinner: false` for this state.
    expect(screen.getByTestId("epic-connection-pill-dot").textContent).toBe("");
    // ...and the plain-dot branch is the one that rendered: it is the only
    // branch that puts the state's own dot colour on a `rounded-full` span.
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "rounded-full",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-amber-500",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("offlineChangesSavedLocally");
    await expectTooltip(
      "The cloud connection is down. Your changes are saved on this device and sync when it is back.",
    );
  });

  describe("settle behavior (750ms hold before claiming synced)", () => {
    it("first mount with a derived synced verdict waits through the settle delay", () => {
      vi.useFakeTimers();
      renderPill("synced");

      expect(screen.getByText("Syncing…")).not.toBeNull();
      expect(pillClaimsSynced()).toBe(false);

      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(pillClaimsSynced()).toBe(true);
    });

    it("flips syncing -> synced only after holding for 750ms, reading Syncing… in between", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("syncing");
      expect(screen.getByText("Syncing…")).not.toBeNull();

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      expect(screen.getByText("Syncing…")).not.toBeNull();
      expect(pillClaimsSynced()).toBe(false);

      act(() => {
        vi.advanceTimersByTime(750);
      });

      expect(pillClaimsSynced()).toBe(true);
    });

    it("never renders All changes synced for a synced window shorter than the settle delay", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("syncing");

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(pillClaimsSynced()).toBe(false);

      mocks.useEpicSyncPillState.mockReturnValue("syncing");
      rerender(pillTree());
      expect(pillClaimsSynced()).toBe(false);
      expect(screen.getByText("Syncing…")).not.toBeNull();

      // The abandoned settle timer from the earlier synced window must not
      // fire later and flash the stale claim.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(pillClaimsSynced()).toBe(false);
    });

    // The display holds "Syncing…" through the settle on purpose - a
    // conservative LABEL is the anti-strobe trade. The tooltip is a different
    // kind of statement: "some changes have not reached the cloud yet" is a
    // fact, and during the hold the derived verdict already says it is false.
    it("drops the syncing tooltip during the settle hold, where the derived verdict is already synced", () => {
      vi.useFakeTimers();
      const pill = () => screen.getByTestId("epic-connection-pill");
      const { rerender } = renderPill("syncing");

      // Control, so the assertion below can't pass vacuously: a genuinely
      // syncing verdict shows the syncing tooltip.
      fireEvent.focus(pill());
      expect(screen.queryByRole("tooltip")?.textContent).toBe(SYNCING_TOOLTIP);

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      // The LABEL still holds "Syncing…" (the anti-strobe trade), but the
      // tooltip must not keep asserting a fact the verdict has already
      // retracted. Every state now carries a tooltip, so the check is that the
      // syncing copy is gone - not that the tooltip vanished.
      expect(screen.getByText("Syncing…")).not.toBeNull();
      fireEvent.focus(pill());
      expect(screen.queryByRole("tooltip")?.textContent).not.toBe(
        SYNCING_TOOLTIP,
      );

      // ...and once the hold expires the pill catches up to the verdict.
      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(pillClaimsSynced()).toBe(true);
    });

    it.each<EpicSyncPillState>([
      "syncing",
      "connected",
      "offline",
      "offlineChangesSavedLocally",
    ])(
      "one-directional guard: from a displayed synced, a derived %s shows immediately with no timer advance at all",
      (nextState) => {
        vi.useFakeTimers();
        const { rerender } = renderPill("synced");
        act(() => {
          vi.advanceTimersByTime(750);
        });
        expect(pillClaimsSynced()).toBe(true);

        mocks.useEpicSyncPillState.mockReturnValue(nextState);
        rerender(pillTree());

        expect(pillClaimsSynced()).toBe(false);
        expect(
          screen
            .getByTestId("epic-connection-pill")
            .getAttribute("data-status"),
        ).toBe(nextState);
      },
    );
  });
});
