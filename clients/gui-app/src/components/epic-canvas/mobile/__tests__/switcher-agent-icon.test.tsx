import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentIcon } from "@/components/epic-canvas/mobile/switcher-agent-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import type { AgentActivityTier } from "@/lib/agent-activity";
import type {
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";

// Drive the epic-selector reads the icon (and the shared status mapping it now
// routes through) depends on. `tui` non-null + type "terminal-agent" reaches
// the TUI badge branch; `tier` is the awareness tier the desktop chat tree
// reads, so setting it here is what proves the switcher shares that source
// rather than the coarser working-id set it used to read.
const state = vi.hoisted(
  (): {
    tier: AgentActivityTier | null;
    gui: string | null;
    tui: string | null;
    role: "owner" | "viewer";
    /** The chat projection's OWN host, i.e. what `useEpicNodeHostId` answers. */
    ownerHostId: string | null;
  } => ({
    tier: null,
    gui: null,
    tui: null,
    role: "owner",
    ownerHostId: null,
  }),
);
vi.mock("@/lib/epic-selectors", () => ({
  useEpicActiveAgentIds: () =>
    state.tier === null ? new Set<string>() : new Set<string>(["n1"]),
  useEpicAgentActivityTiers: () =>
    state.tier === null
      ? new Map<string, AgentActivityTier>()
      : new Map<string, AgentActivityTier>([["n1", state.tier]]),
  useEpicChatHarnessId: () => state.gui,
  useMaybeEpicTuiAgentHarnessId: () => state.tui,
  useEpicPermissionRole: () => state.role,
  useEpicNodeHostId: () => state.ownerHostId,
}));

const NO_INDICATORS: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};

const QUIET: HostNotificationsIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

function chatIndicators(
  flags: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorStateResponse {
  return { epics: {}, chats: { n1: { ...QUIET, ...flags } } };
}

/**
 * A per-origin response, the shape a real host read carries
 * (`scopeIndicatorsToOrigin`). Only the row that names `originHostId` as its
 * own host reads the flags; every other host sees the empty response.
 */
function chatIndicatorsForOrigin(
  originHostId: string,
  flags: Partial<HostNotificationsIndicatorState>,
): SurfaceNotificationIndicators {
  const scoped = chatIndicators(flags);
  return { ...scoped, byOriginHostId: { [originHostId]: scoped } };
}

function renderIcon(
  type: "chat" | "terminal-agent",
  indicators: SurfaceNotificationIndicators,
): ReactNode {
  return (
    <NotificationIndicatorsProvider indicators={indicators}>
      <SwitcherAgentIcon epicId="epic-1" nodeId="n1" type={type} />
    </NotificationIndicatorsProvider>
  );
}

afterEach(() => {
  cleanup();
  state.tier = null;
  state.gui = null;
  state.tui = null;
  state.role = "owner";
  state.ownerHostId = null;
});

describe("<SwitcherAgentIcon /> identity glyphs", () => {
  it("marks a TUI agent with a high-contrast terminal badge chip (solid disc + ring cutout)", () => {
    state.tui = "claude";
    render(renderIcon("terminal-agent", NO_INDICATORS));
    const badge = screen.getByTestId("switcher-tui-badge-n1");
    // A solid accent disc ring-cut against the sheet surface - not the bare
    // muted glyph that vanished at phone size (the live-review defect).
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("bg-primary");
    expect(badge.className).toContain("ring-popover");
    // Still carries a terminal glyph, now legibly sized inside the disc.
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("shows no TUI badge for a plain GUI chat", () => {
    state.gui = "claude";
    render(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-tui-badge-n1")).toBeNull();
  });
});

describe("<SwitcherAgentIcon /> live status", () => {
  it.each(["chat", "terminal-agent"] as const)(
    "shows the working spinner for a %s whose awareness tier is a turn",
    (type) => {
      state.tier = "turn";
      state.gui = "claude";
      state.tui = "claude";
      render(renderIcon(type, NO_INDICATORS));
      expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();
    },
  );

  it.each(["chat", "terminal-agent"] as const)(
    "shows the muted background glyph, not the working spinner, for a background-only %s",
    (type) => {
      state.tier = "background";
      render(renderIcon(type, NO_INDICATORS));
      // The whole point of reading the TIER rather than the working-id set: the
      // switcher used to wear the busy spinner for both.
      expect(
        screen.getByTestId("switcher-agent-background-activity-n1"),
      ).toBeTruthy();
      expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
    },
  );

  it("drops the spinner when the agent stops working, with the sheet still open", () => {
    state.tier = "turn";
    state.gui = "claude";
    const view = render(renderIcon("chat", NO_INDICATORS));
    expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();

    state.tier = null;
    view.rerender(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
    // Back to the idle identity glyph: every status variant renders a
    // `role="status"` span, so their absence is the idle slot.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("picks up a status change pushed while the sheet is open", () => {
    const view = render(renderIcon("chat", NO_INDICATORS));
    expect(screen.queryByTestId("switcher-agent-failure-n1")).toBeNull();

    view.rerender(renderIcon("chat", chatIndicators({ unreadFailure: true })));
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
  });
});

describe("<SwitcherAgentIcon /> matches the desktop mapping", () => {
  // Desktop precedence (`NotificationIndicatorIcon`): attention tones first
  // (failure > fork > interview > approval), then the running tiers, then
  // unread-done. The switcher renders through that same component, so these
  // assert the shared vocabulary reaches the mobile rows at all - each state
  // previously rendered as a plain harness mark.
  const TONE_CASES: ReadonlyArray<{
    readonly name: string;
    readonly flags: Partial<HostNotificationsIndicatorState>;
    readonly testId: string;
  }> = [
    {
      name: "failure",
      flags: { unreadFailure: true },
      testId: "switcher-agent-failure-n1",
    },
    {
      name: "fork",
      flags: { pendingFork: true },
      testId: "switcher-agent-fork-n1",
    },
    {
      name: "interview",
      flags: { pendingInterview: true },
      testId: "switcher-agent-interview-n1",
    },
    {
      name: "approval",
      flags: { pendingApproval: true },
      testId: "switcher-agent-approval-n1",
    },
    {
      name: "unread-done",
      flags: { unreadDone: true },
      testId: "switcher-agent-done-n1",
    },
  ];

  it.each(TONE_CASES)("renders the desktop $name tone", (testCase) => {
    state.gui = "claude";
    render(renderIcon("chat", chatIndicators(testCase.flags)));
    expect(screen.getByTestId(testCase.testId)).toBeTruthy();
  });

  it("lets an attention tone outrank a running turn, as the desktop row does", () => {
    state.tier = "turn";
    render(
      renderIcon("terminal-agent", chatIndicators({ pendingApproval: true })),
    );
    expect(screen.getByTestId("switcher-agent-approval-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
  });

  it("lets a newer running turn own the glyph over a historical failure, which surfaces once the run ends", () => {
    // A chat-scoped host failure is terminal chronology: the running turn owns
    // the glyph while the failure stays in the feed (the desktop mapping since
    // notification history was split from current agent state).
    state.tier = "turn";
    render(
      renderIcon("terminal-agent", chatIndicators({ unreadFailure: true })),
    );
    expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-failure-n1")).toBeNull();
    cleanup();
    state.tier = null;
    render(
      renderIcon("terminal-agent", chatIndicators({ unreadFailure: true })),
    );
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-n1")).toBeNull();
  });

  it("keeps the running turn ahead of unread-done, as the desktop row does", () => {
    state.tier = "turn";
    render(renderIcon("chat", chatIndicators({ unreadDone: true })));
    expect(screen.getByTestId("switcher-agent-activity-n1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-done-n1")).toBeNull();
  });

  it("shows a viewer's read-only lock on a chat row", () => {
    state.role = "viewer";
    state.gui = "claude";
    render(renderIcon("chat", NO_INDICATORS));
    expect(screen.getByLabelText("Read-only agent")).toBeTruthy();
  });
});

describe("<SwitcherAgentIcon /> owner-host scoping", () => {
  // A chat row must name its OWN owner host, off the projection. The list's
  // `useEpicArtifactRecords()` row carries the app-wide ACTIVE host instead
  // (`recordForChat` stamps `fallbackHostId`; only TUI records carry a real
  // owner), so a retained epic tab bound to host A while the user switches the
  // active host to B would hand this icon B - which reads
  // `byOriginHostId[B]`, i.e. nothing, and drops the whole host-derived ladder
  // while epic awareness can still look live.
  it("reads status under the chat's own host, not the active one", () => {
    state.ownerHostId = "host-A";
    state.gui = "claude";
    render(
      renderIcon(
        "chat",
        chatIndicatorsForOrigin("host-A", { unreadFailure: true }),
      ),
    );
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
  });

  it("does not light a row from a same-id chat on another host", () => {
    state.ownerHostId = "host-A";
    state.gui = "claude";
    // `chatId` is host-minted, so host B can legitimately hold the same id.
    render(
      renderIcon(
        "chat",
        chatIndicatorsForOrigin("host-B", { unreadFailure: true }),
      ),
    );
    expect(screen.queryByTestId("switcher-agent-failure-n1")).toBeNull();
  });

  it("falls back to the surface aggregate for a chat with no projected host", () => {
    // A legacy chat predating the field: `useEpicNodeHostId` answers null,
    // which `ChatProgressIcon` reads as "no session, use the aggregate".
    state.ownerHostId = null;
    state.gui = "claude";
    render(
      renderIcon(
        "chat",
        chatIndicatorsForOrigin("host-A", { unreadFailure: true }),
      ),
    );
    expect(screen.getByTestId("switcher-agent-failure-n1")).toBeTruthy();
  });
});
