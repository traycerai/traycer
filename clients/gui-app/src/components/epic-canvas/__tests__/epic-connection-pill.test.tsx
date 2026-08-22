import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import type { EpicChatBackupStatus } from "@/components/epic-canvas/panels/epic-chat-backup-status";
import type { AgentActivityPresenceDegradedReason } from "@/hooks/agent/use-agent-activity-presence-degraded";
import type { CommGraphFeedHealth } from "@/components/epic-canvas/comm-graph/use-comm-graph-feed-health";

const mocks = vi.hoisted(() => ({
  useEpicSyncPillState: vi.fn(),
  chatBackupStatus: null as EpicChatBackupStatus | null,
  presenceDegraded: null as AgentActivityPresenceDegradedReason | null,
  terminalCoverage: null as
    "partial-serving-host" | "complete-fleet" | "complete-local" | null,
  terminalCapability: {
    status: "capable",
    schemaVersion: { major: 2, minor: 1 },
  },
  commGraphFeedHealth: null as CommGraphFeedHealth | null,
}));

vi.mock("@/hooks/agent/use-agent-activity-presence-degraded", () => ({
  useAgentActivityPresenceDegraded: () => mocks.presenceDegraded,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSyncPillState: mocks.useEpicSyncPillState,
  // Mirrors the derivation contract instead of a hand-set flag: every state
  // that REQUIRES a genuine cloud frame this cycle implies the evidence bit,
  // and `connected`/`syncing` default to the handshake-only (no-evidence)
  // reading these tests exercise. Keeps each `mockReturnValue(state)` site
  // self-consistent without threading a second knob through all of them.
  useEpicHasFreshCloudSyncStatus: (): boolean => {
    const state = mocks.useEpicSyncPillState() as EpicSyncPillState;
    return (
      state === "synced" ||
      state === "hostPending" ||
      state === "offlineWithUnsavedChanges" ||
      state === "offlineWithHostPending" ||
      state === "offlineChangesSavedLocally"
    );
  },
}));
vi.mock("@/components/epic-canvas/panels/epic-chat-backup-status", () => ({
  useEpicChatBackupStatus: () => mocks.chatBackupStatus,
}));
vi.mock(
  "@/components/epic-canvas/comm-graph/use-comm-graph-feed-health",
  () => ({
    useCommGraphFeedHealth: () => mocks.commGraphFeedHealth,
  }),
);
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-a",
}));
vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: "host-a",
    coverage: mocks.terminalCoverage,
    capability: mocks.terminalCapability,
  }),
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

/**
 * The hover, one entry per degraded plane: the selected plane's sentence
 * first, then every other degraded plane in source order. A single-plane
 * hover is a bare string, which reads here as one line.
 */
async function tooltipLines(): Promise<ReadonlyArray<string | null>> {
  fireEvent.focus(screen.getByTestId("epic-connection-pill"));
  const tooltip = await screen.findByRole("tooltip");
  const entries = within(tooltip).queryAllByRole("listitem");
  return entries.length === 0
    ? [tooltip.textContent]
    : entries.map((entry) => entry.textContent);
}

describe("<EpicConnectionPill />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.chatBackupStatus = null;
    mocks.presenceDegraded = null;
    mocks.terminalCoverage = null;
    mocks.terminalCapability = {
      status: "capable",
      schemaVersion: { major: 2, minor: 1 },
    };
    mocks.commGraphFeedHealth = null;
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

  // A stream failure the host cannot classify now closes RETRYABLE and the
  // client reconnects forever, so "Reconnecting…" alone no longer implies
  // "back in a moment". After a minute down the copy escalates to say the
  // retry is not converging - same amber severity, and the screen-reader
  // announcement follows the same threshold so a routine reconnect stays
  // silent.
  describe("stalled-link escalation (60s)", () => {
    it("reads Reconnecting… before the escalation threshold, with a silent status region", () => {
      vi.useFakeTimers();
      renderPill("reconnecting");

      expect(screen.getByText("Reconnecting…")).not.toBeNull();
      expect(screen.queryByText("Still reconnecting…")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("");

      act(() => {
        vi.advanceTimersByTime(59_000);
      });

      expect(screen.getByText("Reconnecting…")).not.toBeNull();
      expect(screen.queryByText("Still reconnecting…")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("escalates to Still reconnecting… at 60s and announces it through role=status", () => {
      vi.useFakeTimers();
      renderPill("reconnecting");

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByText("Still reconnecting…")).not.toBeNull();
      expect(screen.queryByText("Reconnecting…")).toBeNull();
      expect(
        screen.getByTestId("epic-connection-pill").getAttribute("aria-label"),
      ).toBe(
        "Still reconnecting. This keeps retrying on its own — unsent changes stay in this window, so keep it open.",
      );
      expect(screen.getByRole("status").textContent).toBe(
        "Still reconnecting. This keeps retrying on its own — unsent changes stay in this window, so keep it open.",
      );
    });

    it("resets the escalation clock once the link recovers, staying silent on a fresh reconnect", () => {
      vi.useFakeTimers();
      const { rerender } = renderPill("reconnecting");

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Still reconnecting…")).not.toBeNull();

      // The link recovers, then drops again - a fresh outage must start its
      // own clock rather than inheriting the earlier escalation.
      mocks.useEpicSyncPillState.mockReturnValue("synced");
      rerender(pillTree());
      mocks.useEpicSyncPillState.mockReturnValue("reconnecting");
      rerender(pillTree());

      expect(screen.getByText("Reconnecting…")).not.toBeNull();
      expect(screen.queryByText("Still reconnecting…")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("");
    });
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

    const pill = screen.getByRole<HTMLButtonElement>("button");
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

    const pill = screen.getByRole<HTMLButtonElement>("button");
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

  it("turns amber for sustained remote-terminal catalog degradation without flashing during the local-first frame", () => {
    vi.useFakeTimers();
    mocks.terminalCoverage = "partial-serving-host";
    renderPill("hostPending");

    expect(screen.getByRole<HTMLButtonElement>("button").dataset.source).toBe(
      "artifact",
    );

    act(() => {
      vi.advanceTimersByTime(749);
    });
    expect(screen.getByRole<HTMLButtonElement>("button").dataset.source).toBe(
      "artifact",
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("terminal-catalog");
    // Dot-only, like the other read-only degradations: the sentence is on
    // hover and in the accessible name, never a permanent label in the row.
    expect(pill.textContent).toBe("");
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-amber-500",
    );
    expect(pill.className).not.toContain("bg-amber-500/10");
    expect(pill.getAttribute("aria-label")).toBe(
      "Remote terminal discovery is unavailable. Showing terminals from this host only. It will recover automatically.",
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Remote terminal discovery is unavailable. Showing terminals from this host only. It will recover automatically.",
    );
  });

  it("shows one plane's copy and lists every other degraded plane on hover", async () => {
    // Two warnings at once: the catalog gap (earlier source, so it wins the
    // tie) and degraded presence, which carries a label of its own. The row
    // must not concatenate them - one light, the selected plane's copy only -
    // while the hover and the accessible name carry both, selected first, so
    // the second outage is not hidden behind the first.
    vi.useFakeTimers();
    mocks.terminalCoverage = "partial-serving-host";
    mocks.presenceDegraded = "cloud-down";
    renderPill("hostPending");
    act(() => {
      vi.advanceTimersByTime(750);
    });

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("terminal-catalog");
    expect(pill.textContent).toBe("");
    const catalogCopy =
      "Remote terminal discovery is unavailable. Showing terminals from this host only. It will recover automatically.";
    const presenceCopy =
      "This device can’t reach the cloud right now, so agents on other devices may show as idle. Agents on this device are live.";
    expect(pill.getAttribute("aria-label")).toBe(
      `${catalogCopy} ${presenceCopy}`,
    );
    expect(screen.getByRole("status").textContent).toBe(
      `${catalogCopy} ${presenceCopy}`,
    );
    vi.useRealTimers();
    expect(await tooltipLines()).toEqual([catalogCopy, presenceCopy]);
  });

  it("does not list a merely busy plane beside a degraded one on hover", async () => {
    // "Backing up chats" is activity, not an outage: when the graph feed is
    // the one degraded plane, the hover stays a single sentence.
    mocks.chatBackupStatus = {
      severity: "activity",
      tooltip: "Backing up chats",
      ariaLabel: "Backing up chats",
    };
    mocks.commGraphFeedHealth = {
      severity: "warning",
      tooltip: "Communication graph feed: reconnecting…",
      ariaLabel: "Communication graph feed: reconnecting…",
    };
    renderPill("synced");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("comm-graph");
    expect(pill.getAttribute("aria-label")).toBe(
      "Communication graph feed: reconnecting…",
    );
    await expectTooltip("Communication graph feed: reconnecting…");
  });

  it("does not report a fleet outage for a local-only RC host", () => {
    vi.useFakeTimers();
    mocks.terminalCoverage = "partial-serving-host";
    mocks.terminalCapability = {
      status: "capable",
      schemaVersion: { major: 1, minor: 0 },
    };
    renderPill("hostPending");

    act(() => {
      vi.advanceTimersByTime(750);
    });

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("artifact");
    expect(pill.textContent).not.toContain("Remote terminals unavailable");
  });

  it("shows the highest severity across artifact sync and chat backup", async () => {
    mocks.chatBackupStatus = {
      severity: "warning",
      tooltip: "Chat backup failing · 1 chat not backed up",
      ariaLabel: "Chat backup failing · 1 chat not backed up",
    };
    renderPill("offline");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("artifact");
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-red-500",
    );
    // The row shows the winner alone; the loser is not dropped, it follows
    // on hover.
    expect(await tooltipLines()).toEqual([
      OFFLINE_COPY,
      "Chat backup failing · 1 chat not backed up",
    ]);
  });

  it("keeps artifact status when warning severities tie", async () => {
    mocks.chatBackupStatus = {
      severity: "warning",
      tooltip: "Chat backup failing · 1 chat not backed up",
      ariaLabel: "Chat backup failing · 1 chat not backed up",
    };
    renderPill("connecting");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("artifact");
    expect(pill.textContent).toContain("Connecting…");
    expect(await tooltipLines()).toEqual([
      "Connecting to server",
      "Chat backup failing · 1 chat not backed up",
    ]);
  });

  const COMM_GRAPH_HEALTH: CommGraphFeedHealth = {
    severity: "warning",
    tooltip: "Communication graph feed: reconnecting…",
    ariaLabel: "Communication graph feed: reconnecting…",
  };

  it("shows the comm-graph feed health as a quiet amber dot when nothing else is degraded", async () => {
    mocks.commGraphFeedHealth = COMM_GRAPH_HEALTH;
    renderPill("synced");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("comm-graph");
    expect(pill.getAttribute("aria-label")).toBe(COMM_GRAPH_HEALTH.tooltip);
    expect(pill.innerHTML).toContain("bg-amber-500");
    expect(pill.textContent).toBe("");
    await expectTooltip(COMM_GRAPH_HEALTH.tooltip);
  });

  it("keeps the artifact indicator when it is danger and the comm-graph feed is only a warning", () => {
    mocks.commGraphFeedHealth = COMM_GRAPH_HEALTH;
    renderPill("offline");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("artifact");
  });

  it("keeps chat backup when it ties with the comm-graph feed - the earlier source wins", () => {
    mocks.chatBackupStatus = {
      severity: "warning",
      tooltip: "Chat backup failing · 1 chat not backed up",
      ariaLabel: "Chat backup failing · 1 chat not backed up",
    };
    mocks.commGraphFeedHealth = COMM_GRAPH_HEALTH;
    renderPill("syncing");

    const pill = screen.getByRole<HTMLButtonElement>("button");
    expect(pill.dataset.source).toBe("chat-backup");
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

  describe("agent-activity presence degraded", () => {
    const PRESENCE_DEGRADED_ARIA =
      "Live agent activity is unavailable. Agent status may be stale or unknown until it reconnects.";
    const CLOUD_DOWN_ARIA =
      "This device can’t reach the cloud right now, so agents on other devices may show as idle. Agents on this device are live.";

    it("shows the amber agent-activity warning over a synced artifact state", () => {
      vi.useFakeTimers();
      mocks.presenceDegraded = "stream-down";
      renderPill("synced");

      act(() => {
        vi.advanceTimersByTime(750);
      });

      const pill = screen.getByRole<HTMLButtonElement>("button");
      expect(pill.textContent).toContain("Agent status may be stale");
      expect(pill.dataset.source).toBe("agent-activity");
      expect(pill.className).toContain("bg-amber-500/10");
      expect(
        screen.getByTestId("epic-connection-pill-dot").className,
      ).toContain("bg-amber-500");
      expect(screen.getByRole("status").textContent).toContain(
        PRESENCE_DEGRADED_ARIA,
      );
    });

    it("loses to an artifact-sync warning like reconnecting", () => {
      mocks.presenceDegraded = "stream-down";
      renderPill("reconnecting");

      const pill = screen.getByRole<HTMLButtonElement>("button");
      expect(pill.dataset.source).toBe("artifact");
      expect(screen.getByText("Reconnecting…")).not.toBeNull();
    });

    it("loses to a chat-backup warning", () => {
      mocks.presenceDegraded = "stream-down";
      mocks.chatBackupStatus = {
        severity: "warning",
        tooltip: "Chat backup failing · 1 chat not backed up",
        ariaLabel: "Chat backup failing · 1 chat not backed up",
      };
      renderPill("synced");

      const pill = screen.getByRole<HTMLButtonElement>("button");
      expect(pill.dataset.source).toBe("chat-backup");
    });

    it("surfaces the presence-degraded message through the tooltip", async () => {
      mocks.presenceDegraded = "stream-down";
      renderPill("synced");

      await expectTooltip(PRESENCE_DEGRADED_ARIA);
    });

    it("shows the cloud-down amber warning over a synced artifact state", () => {
      vi.useFakeTimers();
      mocks.presenceDegraded = "cloud-down";
      renderPill("synced");

      act(() => {
        vi.advanceTimersByTime(750);
      });

      const pill = screen.getByRole<HTMLButtonElement>("button");
      expect(pill.textContent).toContain("Remote agent status unavailable");
      expect(pill.dataset.source).toBe("agent-activity");
      expect(pill.className).toContain("bg-amber-500/10");
      expect(
        screen.getByTestId("epic-connection-pill-dot").className,
      ).toContain("bg-amber-500");
      expect(screen.getByRole("status").textContent).toContain(CLOUD_DOWN_ARIA);
    });

    it("surfaces the cloud-down message through the tooltip", async () => {
      mocks.presenceDegraded = "cloud-down";
      renderPill("synced");

      await expectTooltip(CLOUD_DOWN_ARIA);
    });
  });
});
