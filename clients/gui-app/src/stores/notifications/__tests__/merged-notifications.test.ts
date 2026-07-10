import { describe, expect, it } from "vitest";
import type { HostNotificationEntryV11 } from "@traycer/protocol/host/notifications/contracts";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  appLocalFeedId,
  globalFeedId,
  hostFeedId,
  mergeNotificationFeedIds,
  mergedUnreadCount,
  rowFromAppLocalEntry,
  rowFromHostEntry,
} from "@/stores/notifications/merged-notifications";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";

function hostEntry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntryV11 {
  return {
    id,
    updatedAt,
    readAt,
    kind: "approval.requested",
    sourceRef: "approval-1",
    severity: "needs_action",
    outcome: null,
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "approval-1",
    },
  };
}

function globalEntry(
  id: string,
  createdAt: number,
  readAt: number | null,
): NotificationEntry {
  return {
    id,
    createdAt,
    readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId: "epic-1",
      actorName: "Alice",
    },
  };
}

function appLocalEntry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): AppLocalNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "worktree.setup.failed",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: "Worktree setup failed",
    detail: null,
  };
}

describe("merged notifications feed", () => {
  it("merges sources into one newest-first id projection", () => {
    const ids = mergeNotificationFeedIds(
      [hostEntry("host-old", 10, null), hostEntry("host-new", 30, null)],
      [{ feedId: appLocalFeedId("app-local-mid"), createdAt: 25 }],
      [globalEntry("global-mid", 20, null)],
    );

    expect(ids).toEqual([
      hostFeedId("host-new"),
      appLocalFeedId("app-local-mid"),
      globalFeedId("global-mid"),
      hostFeedId("host-old"),
    ]);
  });

  it("aggregates unread badge counts across all source seams", () => {
    expect(
      mergedUnreadCount({
        hostUnread: 2,
        appLocalUnread: 3,
        globalUnread: 4,
      }),
    ).toBe(9);
  });

  it("derives actionable approval payloads from host entries", () => {
    expect(rowFromHostEntry(hostEntry("approval", 10, null)).payload).toEqual({
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "approval-1",
      sessionId: undefined,
      artifactId: undefined,
    });
  });

  it("formats app-local rows with their own payload and kind", () => {
    expect(rowFromAppLocalEntry(appLocalEntry("setup", 10, null))).toEqual({
      feedId: appLocalFeedId("setup"),
      source: "app-local",
      sourceId: "setup",
      createdAt: 10,
      readAt: null,
      text: "Worktree setup failed",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      hostKind: null,
      appLocalKind: "worktree.setup.failed",
      globalEntry: null,
      severity: "failure",
      outcome: null,
    });
  });
});
