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
import type { EpicChatBackupStatus } from "@/components/epic-canvas/panels/epic-chat-backup-status";

const mocks = vi.hoisted(() => ({
  useEpicSyncPillState: vi.fn(),
  chatBackupStatus: null as EpicChatBackupStatus | null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSyncPillState: mocks.useEpicSyncPillState,
}));
vi.mock("@/components/epic-canvas/panels/epic-chat-backup-status", () => ({
  useEpicChatBackupStatus: () => mocks.chatBackupStatus,
}));

const OFFLINE_COPY =
  "Disconnected. Unsent changes stay in this window until it reconnects — keep it open.";
const OFFLINE_UNSAVED_TOOLTIP =
  "The cloud connection is down, and some recent changes are still being saved on this device. Keep this window open.";

function pillTree() {
  return (
    <TooltipProvider>
      <EpicConnectionPill epicId="epic-a" />
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
    mocks.chatBackupStatus = null;
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

  it("renders connecting as the amber bootstrap pill", async () => {
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
    await expectTooltip("Connecting to server");
  });

  it("renders reconnecting as the amber pill", async () => {
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
    await expectTooltip("Reconnecting to server");
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

  it("keeps normal renderer-to-host saving quiet and makes no synced claim", () => {
    renderPill("syncing");

    expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
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
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("aria-label"),
    ).toBe("Saving changes");
  });

  it("keeps ordinary host-pending churn quiet indefinitely", () => {
    renderPill("hostPending");
    expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("hostPending");
  });

  it("moves active chat backup into the top-right dot tooltip", async () => {
    mocks.chatBackupStatus = {
      severity: "activity",
      tooltip: "Backing up chats",
      ariaLabel: "Backing up chats",
    };
    renderPill("synced");

    const pill = screen.getByTestId("epic-connection-pill");
    expect(pill.textContent).toBe("");
    expect(pill.getAttribute("aria-label")).toBe("Backing up chats");
    await expectTooltip("Backing up chats");
  });

  it("turns the dot amber when chat backup is failing", async () => {
    mocks.chatBackupStatus = {
      severity: "warning",
      tooltip: "Chat backup failing · 1 chat not backed up",
      ariaLabel: "Chat backup failing · 1 chat not backed up",
    };
    renderPill("syncing");

    const pill = screen.getByTestId("epic-connection-pill");
    expect(pill.dataset.source).toBe("chat-backup");
    expect(pill.textContent).toBe("");
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-amber-500",
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Chat backup failing · 1 chat not backed up",
    );
    await expectTooltip("Chat backup failing · 1 chat not backed up");
  });

  it("shows the highest severity across artifact sync and chat backup", async () => {
    mocks.chatBackupStatus = {
      severity: "warning",
      tooltip: "Chat backup failing · 1 chat not backed up",
      ariaLabel: "Chat backup failing · 1 chat not backed up",
    };
    renderPill("offline");

    const pill = screen.getByTestId("epic-connection-pill");
    expect(pill.dataset.source).toBe("artifact");
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-red-500",
    );
    await expectTooltip(OFFLINE_COPY);
  });

  it("shows the unsafe overlap warning immediately without a durability claim", async () => {
    renderPill("offlineWithUnsavedChanges");

    expect(screen.getByText("Offline — saving changes…")).not.toBeNull();
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("offlineWithUnsavedChanges");
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-amber-500/10",
    );
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("aria-label"),
    ).toBe(
      "Offline. Some recent changes are still being saved on this device. Keep this window open.",
    );
    await expectTooltip(OFFLINE_UNSAVED_TOOLTIP);
    expect(screen.getByRole("status").textContent).toContain(
      "Some recent changes are still being saved",
    );
    expect(
      screen
        .getByTestId("epic-connection-pill")
        .contains(screen.getByRole("status")),
    ).toBe(false);
  });

  it("shows host-pending offline work without claiming it is durable", async () => {
    renderPill("offlineWithHostPending");

    expect(screen.getByText("Offline — changes pending")).not.toBeNull();
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
    ).toBe("offlineWithHostPending");
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-amber-500",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").textContent).toBe("");
    expect(
      screen.getByTestId("epic-connection-pill").getAttribute("aria-label"),
    ).toBe(
      "Offline. This device is still processing pending changes; keep it running.",
    );
    await expectTooltip(
      "The cloud connection is down. This device is still processing pending changes; keep it running.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "still processing pending changes",
    );
  });

  it("preserves keyboard focus when a quiet save becomes an offline warning", () => {
    const { rerender } = renderPill("syncing");
    const before = screen.getByTestId("epic-connection-pill");
    before.focus();

    mocks.useEpicSyncPillState.mockReturnValue("offlineWithUnsavedChanges");
    rerender(pillTree());

    const after = screen.getByTestId("epic-connection-pill");
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
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
    it("settles the synced visuals while exposing the raw accessible verdict", () => {
      vi.useFakeTimers();
      renderPill("synced");

      expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
      expect(pillClaimsSynced()).toBe(true);
      expect(
        screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
      ).toBe("syncing");

      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(pillClaimsSynced()).toBe(true);
      expect(
        screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
      ).toBe("synced");
    });

    it("flips syncing -> synced only after holding for 750ms, staying quiet in between", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("syncing");
      expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
      expect(pillClaimsSynced()).toBe(true);
      expect(
        screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
      ).toBe("syncing");

      act(() => {
        vi.advanceTimersByTime(750);
      });

      expect(pillClaimsSynced()).toBe(true);
    });

    it("never renders synced visuals for a synced window shorter than the settle delay", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("syncing");

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(pillClaimsSynced()).toBe(true);
      expect(
        screen.getByTestId("epic-connection-pill").getAttribute("data-status"),
      ).toBe("syncing");

      mocks.useEpicSyncPillState.mockReturnValue("syncing");
      rerender(pillTree());
      expect(pillClaimsSynced()).toBe(false);
      expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");

      // The abandoned settle timer from the earlier synced window must not
      // fire later and flash the stale claim.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(pillClaimsSynced()).toBe(false);
    });

    it("exposes the truthful synced tooltip during the visual settle hold", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("syncing");

      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());

      expect(screen.getByTestId("epic-connection-pill").textContent).toBe("");
      fireEvent.focus(screen.getByTestId("epic-connection-pill"));
      expect(screen.queryByRole("tooltip")?.textContent).toBe(
        "All changes synced",
      );

      // ...and once the hold expires the pill catches up to the verdict.
      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(pillClaimsSynced()).toBe(true);
    });

    it.each<EpicSyncPillState>([
      "syncing",
      "hostPending",
      "offlineWithUnsavedChanges",
      "offlineWithHostPending",
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
