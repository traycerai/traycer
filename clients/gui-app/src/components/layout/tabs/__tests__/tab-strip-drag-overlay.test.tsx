/**
 * `HeaderTabDragOverlay` renders in a `<DragOverlay>` sibling of the strip's
 * own subtree (see `root-dnd-provider.tsx`), so it cannot read
 * `appearance` or the notification badge off a live query/context -
 * both ride `props.ghost`, resolved ONCE by the strip item at drag start
 * (`HeaderTabDragGhost` in `dnd-store.ts`). Fakes only the free
 * `useSyncExternalStore` hooks (activity, title-generation); proves the
 * ghost's identity tint and indicator state render without any query hook
 * ever being invoked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HeaderTabDragOverlay } from "../tab-strip-drag-overlay";
import type { HeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTab } from "@/stores/tabs/types";

const mocks = vi.hoisted(() => ({
  useEpicActivityStatus: vi.fn(),
  useRegisteredEpicTitleGenerating: vi.fn(),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: mocks.useEpicActivityStatus,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitleGenerating: mocks.useRegisteredEpicTitleGenerating,
  useRegisteredEpicTitle: () => null,
}));

function epicTab(): Extract<HeaderTab, { kind: "epic" }> {
  return {
    kind: "epic",
    id: "tab-1",
    epicId: "epic-1",
    hostId: "host-a",
    route: "/x",
    name: "Task",
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
    // The base/unresolved tab never carries an identity - `ghost` is the
    // only source `HeaderTabDragOverlay` reads it from.
    appearance: null,
  };
}

function idleIndicatorState(): NotificationIndicatorState {
  return {
    unreadFailure: false,
    unreadNonTerminalFailure: false,
    unreadTerminalFailure: false,
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadDone: false,
  };
}

function ghostWith(overrides: Partial<HeaderTabDragGhost>): HeaderTabDragGhost {
  return {
    appearance: null,
    indicatorState: idleIndicatorState(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HeaderTabDragOverlay: ghost-carried identity + indicator state", () => {
  it("threads the ghost's identity color into the chip border without any appearance/notification hook", () => {
    const tab = epicTab();
    const ghost = ghostWith({
      appearance: {
        color: "#654321",
        icon: "🚀",
      },
    });
    mocks.useEpicActivityStatus.mockReturnValue("turn");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);

    render(<HeaderTabDragOverlay tab={tab} ghost={ghost} width={200} />);

    expect(screen.getByTestId("tab-chrome-center").style.borderTopColor).toBe(
      "rgb(101, 67, 33)",
    );
    // Identity icon (emoji) and the running-activity status render together.
    expect(screen.getByText("\u{1f680}")).toBeTruthy();
    expect(screen.getByTestId("header-tab-activity-tab-1")).toBeTruthy();
  });

  it("still renders the identity icon when the epic has no live activity", () => {
    const tab = epicTab();
    const ghost = ghostWith({
      appearance: {
        color: "#0a0a0a",
        icon: "🚀",
      },
    });
    mocks.useEpicActivityStatus.mockReturnValue("idle");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);

    render(<HeaderTabDragOverlay tab={tab} ghost={ghost} width={200} />);

    expect(screen.queryByTestId("header-tab-activity-tab-1")).toBeNull();
    expect(screen.getByText("\u{1f680}")).toBeTruthy();
  });

  it("surfaces the ghost's notification badge alongside the identity tint", () => {
    const tab = epicTab();
    const ghost = ghostWith({
      appearance: {
        color: "#334455",
        icon: "🚀",
      },
      indicatorState: { ...idleIndicatorState(), pendingApproval: true },
    });
    mocks.useEpicActivityStatus.mockReturnValue("idle");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);

    render(<HeaderTabDragOverlay tab={tab} ghost={ghost} width={200} />);

    expect(screen.getByTestId("header-tab-approval-tab-1")).toBeTruthy();
    expect(screen.getByTestId("tab-chrome-center").style.borderTopColor).toBe(
      "rgb(51, 68, 85)",
    );
  });

  it("falls back to no identity and an empty badge when the ghost is null", () => {
    const tab = epicTab();
    mocks.useEpicActivityStatus.mockReturnValue("idle");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);

    render(<HeaderTabDragOverlay tab={tab} ghost={null} width={200} />);

    expect(screen.getByTestId("header-tab-drag-overlay")).toBeTruthy();
    expect(screen.queryByTestId("header-tab-approval-tab-1")).toBeNull();
  });
});
