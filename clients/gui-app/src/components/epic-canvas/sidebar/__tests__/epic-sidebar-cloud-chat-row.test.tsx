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

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "unreachable",
    hostLabel: "Tanveer's laptop",
  }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => () => undefined,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: () => () => undefined,
}));

afterEach(() => {
  cleanup();
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
});
