import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";

/**
 * The row's HOST SCOPE, pinned.
 *
 * This is a regression, not a coverage exercise: the row first shipped reading
 * `useTabHostId()`, and the sidebar is not a tab - it renders outside
 * `<TabHostProvider>`. The guard threw, an error boundary caught it, and the
 * production failure mode was therefore a silently missing row rather than a
 * crash. Nothing about that is visible in a type check, so it needs a mount.
 *
 * The assertion is the MECHANISM: this suite deliberately does NOT wrap the row
 * in a `<TabHostProvider>`, so a tab-scoped host read throws and the render
 * fails. Nothing here clicks anything - jsdom passes clicks on pointer-inert
 * elements, so the open path is verified in the live app instead.
 */

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-a",
}));

const reachability = { status: "unreachable", hostLabel: "Tanveer's laptop" };

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => reachability,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));

/**
 * The canvas open actions, captured. The row's whole job on click is to hand a
 * tile ref to one of these, so what it hands over IS the behaviour under test.
 */
const openedRefs: { type: string; id: string }[] = [];

vi.mock("@/stores/epics/canvas/store", () => ({
  // The canvas actions take `(tabId, ref)`; the ref is the second argument.
  useEpicCanvasStore: () => (_tabId: string, ref: { type: string; id: string }) => {
    openedRefs.push({ type: ref.type, id: ref.id });
  },
}));

/** Whether this device's epic tree holds the chat behind the row. */
const localRecord: { current: object | null } = { current: null };

vi.mock("@/lib/epic-selectors", () => ({
  useChatById: () => localRecord.current,
}));

afterEach(() => {
  cleanup();
  reachability.status = "unreachable";
  localRecord.current = null;
  openedRefs.length = 0;
});

/**
 * `useEpicNestedFocusNavigation` runs its `prepare` callback, so clicking a row
 * reaches the canvas action with the ref the row chose. That is the seam the
 * silent no-op lived at, and it is what these assert.
 */
function clickRow(): void {
  screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`).click();
}

const CHAT: CloudChatSummary = {
  identity: {
    taskId: "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7",
    chatId: "56254cae-aa80-4d06-914c-5086cdd65e3c",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-b",
  createdAt: 100,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: 300,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

describe("EpicSidebarCloudChatRow", () => {
  it("renders outside a TabHostProvider", () => {
    // The whole regression. A tab-scoped host read would throw here.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
      />,
    );
    expect(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });

  it("names the owning host on the lock rather than a section heading", () => {
    // Hosts are a property of the row now. The lock carries the host's name so
    // the statement survives without the "other devices" heading that used to
    // make it.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
      />,
    );
    expect(
      screen.getByLabelText("On Tanveer's laptop, offline"),
    ).toBeTruthy();
  });

  it("keeps the row's accessible name to the chat title", () => {
    // The row carries a lock and a timestamp, each with its own accessible
    // name; without an explicit label it would announce as all three run
    // together - the same reason the local rows set one.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Walkthrough" }),
    ).toBeTruthy();
  });

  it("drops the lock when the chat is here and its owner is reachable", () => {
    // The lock is the chat's STATE. It is dropped for a row that will really
    // open live - which needs the chat present on this device as well as its
    // owner answering; a reachable host that does not hold the chat cannot
    // steer it, so claiming otherwise would be the false statement.
    reachability.status = "reachable";
    localRecord.current = { id: CHAT.identity.chatId };
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
      />,
    );
    expect(
      screen.queryByTestId(
        `epic-sidebar-cloud-lock-${CHAT.identity.chatId}`,
      ),
    ).toBeNull();
  });

  it("locks the row while the owning host is unreachable", () => {
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
      />,
    );
    expect(
      screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });

  describe("what a click actually opens", () => {
    function renderRow(): void {
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
        />,
      );
    }

    it("opens the published copy when the chat is not on this device", () => {
      // The user-visible defect: the owner's host id answered (two dev slots
      // share one id), so the row routed to a LIVE record-backed tile for a
      // chat absent from this device's tree - and the canvas silently opened
      // nothing at all. Reachable is necessary, not sufficient.
      reachability.status = "reachable";
      localRecord.current = null;
      renderRow();
      clickRow();
      expect(openedRefs).toHaveLength(1);
      expect(openedRefs[0].type).toBe("published-chat");
    });

    it("opens the live chat when the chat IS here and its owner answers", () => {
      reachability.status = "reachable";
      localRecord.current = { id: CHAT.identity.chatId };
      renderRow();
      clickRow();
      expect(openedRefs).toEqual([
        { type: "chat", id: CHAT.identity.chatId },
      ]);
    });

    it("opens the published copy when the owner is unreachable", () => {
      reachability.status = "unreachable";
      localRecord.current = { id: CHAT.identity.chatId };
      renderRow();
      clickRow();
      expect(openedRefs[0].type).toBe("published-chat");
    });

    it("never leaves a click opening nothing", () => {
      // The shape of the bug rather than one instance of it: whatever the
      // reachability/presence combination, a click must hand the canvas a ref.
      for (const status of ["reachable", "unreachable", "checking"]) {
        for (const present of [true, false]) {
          reachability.status = status;
          localRecord.current = present ? { id: CHAT.identity.chatId } : null;
          renderRow();
          clickRow();
          expect(openedRefs.length).toBeGreaterThan(0);
          openedRefs.length = 0;
          cleanup();
        }
      }
    });
  });

  describe("the row's icon says STATE, not where the row came from", () => {
    it("draws the same base chat icon as a local row", () => {
      // No row-kind iconography: a distinct glyph for "came from the cloud
      // list" would re-encode the demolished section as an icon.
      reachability.status = "reachable";
      localRecord.current = { id: CHAT.identity.chatId };
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
        />,
      );
      const row = screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
      expect(row.querySelector(".lucide-message-square")).toBeTruthy();
      expect(
        screen.queryByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
      ).toBeNull();
    });

    it("badges the lock exactly when the click would open a published copy", () => {
      reachability.status = "reachable";
      localRecord.current = null;
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
        />,
      );
      expect(
        screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
      ).toBeTruthy();
    });
  });
});
