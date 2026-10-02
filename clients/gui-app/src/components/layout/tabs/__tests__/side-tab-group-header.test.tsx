/**
 * The vertical strip's group header (S-19): the shared group editor on
 * right-click, mirrored off the sidebar column, and the rail's tile. The
 * count, the click that folds the group and the collapsed group's worst
 * member badge (S-30) are `side-tab-strip.test.tsx`'s, through the real strip;
 * the badge ranking is `side-tab-rail-badge.test.tsx`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { SideTabGroupHeader } from "@/components/layout/tabs/side-strip/side-tab-group-header";
import type { SideTabRowVariant } from "@/components/layout/tabs/side-strip/side-tab-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { tabItemId, tabRefKey } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import type { TabRef } from "@/stores/tabs/types";

// The editor's "New tab in group" navigates; nothing here is about routing.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const GROUP_ID = "g";
const QUIET = {
  pendingApproval: false,
  pendingInterview: false,
  unreadFailure: false,
  unreadDone: false,
  pendingFork: false,
};

/** A group with one member tab: the store drops a group that has none. */
function seedGroup(collapsed: boolean): TabGroup {
  const group: TabGroup = { name: "Work", color: "#8ab4f8", collapsed };
  const member: TabRef = { kind: "epic", id: "e-1" };
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(member), ref: member }],
    activeItemId: tabItemId(member),
    stripOrder: [member],
    systemTabs: { history: null, settings: null },
    groups: { [GROUP_ID]: group },
    customizations: {
      [tabRefKey(member)]: { color: null, icon: null, groupId: GROUP_ID },
    },
  });
  return group;
}

function renderHeader(input: {
  readonly group: TabGroup;
  readonly variant: SideTabRowVariant;
  readonly memberEntities: ReadonlyArray<HostNotificationsEntityRef>;
  readonly indicators: SurfaceNotificationIndicators;
  /** The nearest vertical column's edge, `null` outside a column (D7). */
  readonly columnSide: EdgeSide | null;
}): void {
  render(
    <ColumnEdgeContext.Provider value={input.columnSide}>
      <TooltipProvider>
        <NotificationIndicatorsContext.Provider value={input.indicators}>
          <SideTabGroupHeader
            groupId={GROUP_ID}
            group={input.group}
            variant={input.variant}
            memberCount={3}
            memberEntities={input.memberEntities}
            onClose={() => undefined}
          />
        </NotificationIndicatorsContext.Provider>
      </TooltipProvider>
    </ColumnEdgeContext.Provider>,
  );
}

/** The Radix Popover Content node that owns the `data-side`/`data-align` Popper wrote. */
function groupEditorPopoverContent(): HTMLElement {
  const content = document.querySelector<HTMLElement>(
    '[data-slot="popover-content"]',
  );
  if (content === null) throw new Error("group editor popover not found");
  return content;
}

function header(): HTMLElement {
  return screen.getByTestId(`side-tab-group-header-${GROUP_ID}`);
}

describe("SideTabGroupHeader", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    __resetAppLocalNotificationsStoreForTests();
  });

  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("opens the shared group editor on right-click", () => {
    renderHeader({
      group: seedGroup(false),
      variant: "expanded",
      memberEntities: [],
      indicators: { epics: {}, chats: {} },
      columnSide: null,
    });

    fireEvent.contextMenu(header());

    expect(screen.getByRole("textbox", { name: "Group name" })).toBeDefined();
    expect(screen.getByText("Ungroup")).toBeDefined();
  });

  it.each([
    ["left", "right"],
    ["right", "left"],
  ] as const)(
    "opens the group editor popover mirrored off a %s sidebar column (side=%s)",
    (columnSide, expectedSide) => {
      renderHeader({
        group: seedGroup(false),
        variant: "expanded",
        memberEntities: [],
        indicators: { epics: {}, chats: {} },
        columnSide,
      });

      fireEvent.contextMenu(header());

      const content = groupEditorPopoverContent();
      expect(content.getAttribute("data-side")).toBe(expectedSide);
      expect(content.getAttribute("data-align")).toBe("start");
    },
  );

  it("is a tile with the name's first letter in the rail", () => {
    renderHeader({
      group: seedGroup(true),
      variant: "collapsed",
      memberEntities: [{ epicId: "e-1" }],
      indicators: {
        epics: { "e-1": { ...QUIET, unreadFailure: true } },
        chats: {},
      },
      columnSide: null,
    });

    expect(header().textContent).toBe("W");
    expect(
      screen.getByTestId("side-tab-group-badge").getAttribute("data-kind"),
    ).toBe("failed");
    expect(screen.queryByTestId("side-tab-group-count")).toBeNull();
  });

  it("shows the member count only while the group is collapsed", () => {
    renderHeader({
      group: seedGroup(false),
      variant: "expanded",
      memberEntities: [],
      indicators: { epics: {}, chats: {} },
      columnSide: null,
    });
    expect(screen.queryByTestId("side-tab-group-count")).toBeNull();
    cleanup();

    renderHeader({
      group: seedGroup(true),
      variant: "expanded",
      memberEntities: [],
      indicators: { epics: {}, chats: {} },
      columnSide: null,
    });
    expect(screen.getByTestId("side-tab-group-count").textContent).toBe("3");
  });

  it("leaves out the name of an unnamed group, keeping the chevron", () => {
    const group: TabGroup = { name: "", color: "#8ab4f8", collapsed: false };
    const member: TabRef = { kind: "epic", id: "e-1" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(member), ref: member }],
      activeItemId: tabItemId(member),
      stripOrder: [member],
      systemTabs: { history: null, settings: null },
      groups: { [GROUP_ID]: group },
      customizations: {
        [tabRefKey(member)]: { color: null, icon: null, groupId: GROUP_ID },
      },
    });
    renderHeader({
      group,
      variant: "expanded",
      memberEntities: [],
      indicators: { epics: {}, chats: {} },
      columnSide: null,
    });

    expect(header().textContent).toBe("");
    expect(screen.queryByTestId("side-tab-group-name")).toBeNull();
  });
});
