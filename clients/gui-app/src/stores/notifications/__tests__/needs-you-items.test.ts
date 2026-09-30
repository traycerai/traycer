import { createElement } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostNotificationsCloudFeedRowV11 } from "@traycer/protocol/host/notifications/contracts";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  groupNeedsYouByEpic,
  needsYouReasonOf,
  selectNeedsYouItems,
  useNeedsYouItems,
  type NeedsYouReason,
} from "@/stores/notifications/needs-you-items";

/**
 * `selectNeedsYouItems` / `needsYouReasonOf` (D10): the pure selector behind
 * the Notifications drawer's Needs you group and its count. Rows are built by hand rather
 * than through a live store, since the selector's contract is entirely a
 * function of the merged row - resolution, host kind, and payload. The group's
 * order and its exclusions through the real store are
 * `notifications-popover.test.tsx`'s.
 */

function buildRow(
  overrides: Partial<MergedNotificationRow>,
): MergedNotificationRow {
  return {
    feedId: "host:approval-1",
    source: "host",
    sourceId: "approval-1",
    createdAt: 1_000,
    readAt: null,
    title: "Deploy checkout fix",
    body: "",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "approval-1",
      sessionId: undefined,
      artifactId: undefined,
    },
    hostKind: "approval.requested",
    appLocalKind: null,
    globalEntry: null,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    sourceRef: "approval-1",
    originHostId: "host-a",
    providerPackAttribution: null,
    category: "task",
    ...overrides,
  };
}

const INTERVIEW_PAYLOAD: MergedNotificationRow["payload"] = {
  kind: "interview",
  epicId: "epic-1",
  chatId: "chat-1",
  interviewBlockId: undefined,
};

const REASON_CASES: ReadonlyArray<
  readonly [string, Partial<MergedNotificationRow>, NeedsYouReason | null]
> = [
  ["an unresolved approval", {}, "approval"],
  [
    "an unresolved interview",
    { hostKind: "interview.requested", payload: INTERVIEW_PAYLOAD },
    "reply",
  ],
  // Auto-judge (S-41) never files an approval otherwise.
  ["a resolved approval", { resolvedAt: 2_000 }, null],
  [
    "a resolved interview",
    { hostKind: "interview.requested", resolvedAt: 2_000 },
    null,
  ],
  // Read vs unread does not matter.
  ["an already-read but unresolved prompt", { readAt: 1_500 }, "approval"],
  [
    "browser.human.needed",
    { hostKind: "browser.human.needed", payload: null },
    null,
  ],
  [
    "any other host kind, e.g. a stopped-agent failure",
    { hostKind: "agent.stopped", severity: "failure", payload: null },
    null,
  ],
  [
    "a row with no host kind (app-local)",
    { source: "app-local", hostKind: null },
    null,
  ],
];

describe("needsYouReasonOf", () => {
  it.each(REASON_CASES)("reads %s as %s", (_name, overrides, expected) => {
    expect(needsYouReasonOf(buildRow(overrides))).toBe(expected);
  });
});

describe("selectNeedsYouItems", () => {
  it("assigns 'Approval requested' / 'Question waiting' asks per reason", () => {
    const approval = selectNeedsYouItems([buildRow({})], () => null);
    expect(approval[0]?.ask).toBe("Approval requested");

    const interview = selectNeedsYouItems(
      [
        buildRow({
          hostKind: "interview.requested",
          payload: INTERVIEW_PAYLOAD,
        }),
      ],
      () => null,
    );
    expect(interview[0]?.ask).toBe("Question waiting");
  });

  it("reads taskTitle from the row's title", () => {
    const items = selectNeedsYouItems(
      [buildRow({ title: "Ship the release" })],
      () => null,
    );
    expect(items[0]?.taskTitle).toBe("Ship the release");
  });

  it("reads agentTitle from the injected resolver, per row", () => {
    const items = selectNeedsYouItems(
      [buildRow({ feedId: "host:x", sourceId: "x" })],
      (row) => (row.feedId === "host:x" ? "Deploy agent" : null),
    );
    expect(items[0]?.agentTitle).toBe("Deploy agent");
  });
});

describe("groupNeedsYouByEpic", () => {
  it("groups approvals and interviews by the epic they name, dropping an epic-less approval", () => {
    const items = selectNeedsYouItems(
      [
        buildRow({ feedId: "host:a", sourceId: "a" }),
        buildRow({
          feedId: "host:b",
          sourceId: "b",
          hostKind: "interview.requested",
          payload: INTERVIEW_PAYLOAD,
        }),
        buildRow({
          feedId: "host:c",
          sourceId: "c",
          hostKind: "interview.requested",
          payload: {
            kind: "interview",
            epicId: "epic-2",
            chatId: "chat-2",
            interviewBlockId: undefined,
          },
        }),
        buildRow({
          feedId: "host:d",
          sourceId: "d",
          payload: {
            kind: "approval",
            epicId: undefined,
            chatId: "chat-1",
            approvalId: "approval-1",
            sessionId: undefined,
            artifactId: undefined,
          },
        }),
      ],
      () => null,
    );

    const groups = groupNeedsYouByEpic(items);

    expect([...groups.keys()]).toEqual(["epic-1", "epic-2"]);
    expect(groups.get("epic-1")?.map((item) => item.row.sourceId)).toEqual([
      "a",
      "b",
    ]);
    expect(groups.get("epic-2")?.map((item) => item.row.sourceId)).toEqual([
      "c",
    ]);
  });
});

/**
 * `useNeedsYouItems` against a real `useCloudNotificationsStore` snapshot
 * (finding 3): the cloud store keys its rows by `cloudNotificationFeedId`,
 * not by the bare `entryId`, so this exercises the actual wiring the pure
 * selector's hand-built rows above cannot catch.
 */
describe("useNeedsYouItems (cloud store wiring)", () => {
  beforeEach(() => {
    useCloudNotificationsStore.getState().reset();
  });

  afterEach(() => {
    useCloudNotificationsStore.getState().reset();
  });

  function cloudApprovalRow(
    entryId: string,
    chatTitle: string,
  ): HostNotificationsCloudFeedRowV11 {
    return {
      entryId,
      originHostId: "host-a",
      coalesceKey: "approval.requested:chat-1",
      entry: {
        id: entryId,
        updatedAt: 1_000,
        readAt: null,
        kind: "approval.requested",
        sourceRef: entryId,
        severity: "needs_action",
        outcome: null,
        resolvedAt: null,
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "approval",
          epicId: "epic-1",
          chatId: "chat-1",
          chatTitle: "Fallback title",
          taskTitle: "Fallback title",
          approvalId: entryId,
        },
      },
      presentation: { epicTitle: "Epic", chatTitle },
    };
  }

  it("reads a cloud item's agentTitle from its chatTitle, keyed by feedId not the bare entryId", () => {
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudApprovalRow("approval-1", "Deploy checkout fix")],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
        version: 1,
      });
    });

    const { result } = renderHook(() => useNeedsYouItems(), {
      wrapper: (props: { readonly children: React.ReactNode }) =>
        createElement(
          NotificationFeedModeContext.Provider,
          { value: "cloud" },
          props.children,
        ),
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.agentTitle).toBe("Deploy checkout fix");
  });
});
