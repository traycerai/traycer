import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";

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

// Typed against the hook's own union so the stand-in cannot produce a status
// the production code has no branch for - an unchecked string here would let a
// typo silently render the unreachable arm under a "reachable" test name.
const reachability: { status: HostReachabilityStatus; hostLabel: string } = {
  status: "unreachable",
  hostLabel: "Tanveer's laptop",
};

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
const openedRefs: { type: string; id: string; hostId: string }[] = [];

vi.mock("@/stores/epics/canvas/store", () => ({
  // The canvas actions take `(tabId, ref)`; the ref is the second argument.
  useEpicCanvasStore:
    () =>
    (_tabId: string, ref: { type: string; id: string; hostId: string }) => {
      openedRefs.push({ type: ref.type, id: ref.id, hostId: ref.hostId });
    },
}));

afterEach(() => {
  cleanup();
  reachability.status = "unreachable";
  openedRefs.length = 0;
});

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

/**
 * `useEpicNestedFocusNavigation` runs its `prepare` callback, so clicking a row
 * reaches the canvas action with the ref the row chose.
 */
function clickRow(): void {
  screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`).click();
}

describe("EpicSidebarCloudChatRow", () => {
  it("renders outside a TabHostProvider", () => {
    // The whole regression. A tab-scoped host read would throw here.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });

  it("names the owning host in the ROW's accessible name, not on the glyph", () => {
    // Hosts are a property of the row now, and so is being locked. An
    // `aria-label` on the glyph inside a labelled button never surfaces, and the
    // tooltip beside it is hover-only, so the state has to reach the name the
    // row announces or it reaches nobody.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Walkthrough — On Tanveer's laptop, offline",
      }),
    ).toBeTruthy();
  });

  it("keeps a reachable row's accessible name to the chat title", () => {
    // The row carries a timestamp with its own text; without an explicit label
    // it would announce as both run together - the same reason the local rows
    // set one. A row that is NOT locked has nothing to add to the title.
    reachability.status = "reachable";
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Walkthrough" })).toBeTruthy();
  });

  it("drops the lock when the chat is here and its owner is reachable", () => {
    // The lock is the chat's STATE. It is dropped for a row that will really
    // open live - which needs the chat present on this device as well as its
    // owner answering; a reachable host that does not hold the chat cannot
    // steer it, so claiming otherwise would be the false statement.
    reachability.status = "reachable";
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.queryByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
    ).toBeNull();
  });

  it("locks the row while the owning host is unreachable", () => {
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        epicId={CHAT.identity.taskId}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
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
          selectionMode={false}
        />,
      );
    }

    it("opens LIVE, bound to the owner host, when the owner is reachable", () => {
      // Host ids are unique (2026-08-07 ruling): a reachable owner IS the
      // machine that holds this chat, so the click opens the ordinary live
      // chat ref against it - the same ref shape a tree row opens - and the
      // tile subscribes cross-host without needing a local projection record.
      reachability.status = "reachable";
      renderRow();
      clickRow();
      expect(openedRefs).toHaveLength(1);
      expect(openedRefs[0].type).toBe("chat");
      expect(openedRefs[0].id).toBe(CHAT.identity.chatId);
      expect(openedRefs[0].hostId).toBe(CHAT.ownerHostId);
    });

    it("opens the published copy when the owner is unreachable", () => {
      reachability.status = "unreachable";
      renderRow();
      clickRow();
      expect(openedRefs[0].type).toBe("published-chat");
    });

    it("opens NOTHING while the sidebar is in bulk-selection mode", () => {
      // A cloud row is not selectable - archive and delete are the bulk actions
      // and neither belongs to a chat this device does not own - so it goes
      // inert rather than navigating away from a selection in progress.
      reachability.status = "unreachable";
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
          selectionMode
        />,
      );
      clickRow();
      expect(openedRefs).toHaveLength(0);
    });

    it("never leaves a click opening nothing", () => {
      // The shape of the bug rather than one instance of it: whatever the
      // reachability/presence combination, a click must hand the canvas a ref.
      const statuses: readonly HostReachabilityStatus[] = [
        "reachable",
        "unreachable",
        "checking",
      ];
      for (const status of statuses) {
        {
          reachability.status = status;
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
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
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

    it("badges the lock exactly when the owning host is unreachable", () => {
      reachability.status = "unreachable";
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          epicId={CHAT.identity.taskId}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      expect(
        screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
      ).toBeTruthy();
    });
  });
});
