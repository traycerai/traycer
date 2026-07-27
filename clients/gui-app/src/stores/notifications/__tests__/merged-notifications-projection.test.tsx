import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import type { HostNotificationsSummary } from "@traycer/protocol/host/notifications/contracts";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  createNotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  ALL_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  appLocalFeedId,
  globalFeedId,
  hostFeedId,
  notificationBellAccessibleLabel,
  useAttentionNotificationIds,
  useMergedNotificationIds,
  useMergedNotificationRow,
  useNotificationBellState,
  useNotificationCenterHostState,
  useRecentNotificationIds,
  type NotificationBellState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

function hostPrompt(
  id: string,
  updatedAt: number,
  resolvedAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt: null,
    kind: "approval.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      approvalId: id,
    },
  };
}

function hostInterview(
  id: string,
  updatedAt: number,
  resolvedAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt: null,
    kind: "interview.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "interview",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      interviewBlockId: "block-1",
    },
  };
}

function hostFailure(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "failure",
    outcome: "errored",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      outcome: "errored",
      code: "RATE_LIMIT",
    },
  };
}

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      outcome: "completed",
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
    kind: "stream.transport.error",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: `Message ${id}`,
    detail: null,
    displayedUpdatedAt: null,
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

function buildSnapshot(entries: ReadonlyArray<NotificationEntry>): Uint8Array {
  const donor = new Y.Doc();
  const arr = donor.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  donor.transact(() => {
    for (const entry of entries) {
      arr.push([createNotificationRoomEntryMap(entry)]);
    }
  });
  return Y.encodeStateAsUpdate(donor);
}

function openGlobalStream(): {
  readonly seed: (entries: ReadonlyArray<NotificationEntry>) => void;
} {
  let current: NotificationsStreamCallbacks | null = null;
  openNotificationsStream((callbacks) => {
    current = callbacks;
    return {
      applyUpdate: () => {},
      close: () => {},
    };
  }, null);
  return {
    seed: (entries) => {
      if (current === null) throw new Error("stream factory not invoked");
      current.onSnapshot({ schemaVersion: "2" }, buildSnapshot(entries));
    },
  };
}

function seedGlobal(entries: ReadonlyArray<NotificationEntry>): void {
  openGlobalStream().seed(entries);
}

function applyHostSnapshot(
  entries: ReadonlyArray<HostNotificationEntry>,
  summary: HostNotificationsSummary,
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: entries.filter(
        (item) =>
          item.severity === "needs_action" || item.severity === "failure",
      ),
      nextCursor: null,
    },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function seedAppLocal(entries: ReadonlyArray<AppLocalNotificationEntry>): void {
  const store = useAppLocalNotificationsStore.getState();
  store.activateIdentity("user-test");
  for (const entry of entries) {
    store.upsert(entry);
  }
}

function resetPopoverFilters(): void {
  useNotificationsPopoverStore.setState({
    open: false,
    unreadOnly: false,
    categories: ALL_NOTIFICATION_CATEGORIES,
  });
}

function partitionIds(
  attention: ReadonlyArray<string>,
  recent: ReadonlyArray<string>,
): {
  readonly attentionSet: Set<string>;
  readonly recentSet: Set<string>;
} {
  return {
    attentionSet: new Set(attention),
    recentSet: new Set(recent),
  };
}

describe("merged notification projection (Attention / Recent)", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    resetPopoverFilters();
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // Equal timestamps must tie-break feedId ASC (matches SQLite id ASC); pre-fix DESC would reverse these.
  it("breaks equal-createdAt ties by ascending feedId", () => {
    applyHostSnapshot(
      [hostDone("zebra", 100, null), hostDone("alpha", 100, null)],
      { unreadCount: 2, attentionCount: 0 },
    );
    seedAppLocal([appLocalEntry("mid", 100, null)]);
    seedGlobal([globalEntry("beta", 100, null)]);

    const { result: all } = renderHook(() => useMergedNotificationIds());
    expect(all.current).toEqual([
      appLocalFeedId("mid"),
      globalFeedId("beta"),
      hostFeedId("alpha"),
      hostFeedId("zebra"),
    ]);
  });

  it("places each row in exactly one of Attention or Recent", () => {
    applyHostSnapshot(
      [
        hostPrompt("prompt", 100, null),
        hostFailure("failure", 90, null),
        hostDone("done", 80, null),
      ],
      { unreadCount: 3, attentionCount: 2 },
    );
    seedAppLocal([appLocalEntry("app-fail", 70, null)]);
    seedGlobal([globalEntry("global-1", 60, null)]);

    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );
    const { result: recent } = renderHook(() => useRecentNotificationIds());
    const { result: all } = renderHook(() => useMergedNotificationIds());

    const expected = [
      hostFeedId("prompt"),
      hostFeedId("failure"),
      hostFeedId("done"),
      appLocalFeedId("app-fail"),
      globalFeedId("global-1"),
    ];
    expect(new Set(all.current)).toEqual(new Set(expected));

    const { attentionSet, recentSet } = partitionIds(
      attention.current,
      recent.current,
    );
    for (const id of expected) {
      const inAttention = attentionSet.has(id);
      const inRecent = recentSet.has(id);
      expect(inAttention || inRecent).toBe(true);
      expect(inAttention && inRecent).toBe(false);
    }

    expect(attention.current).toEqual([
      hostFeedId("prompt"),
      hostFeedId("failure"),
      appLocalFeedId("app-fail"),
    ]);
    expect(recent.current).toEqual([
      hostFeedId("done"),
      globalFeedId("global-1"),
    ]);
  });

  it("keeps global rows in Recent only", () => {
    seedGlobal([
      globalEntry("g-unread", 50, null),
      globalEntry("g-read", 40, 10),
    ]);

    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );
    const { result: recent } = renderHook(() => useRecentNotificationIds());

    expect(attention.current).toEqual([]);
    expect(recent.current).toEqual([
      globalFeedId("g-unread"),
      globalFeedId("g-read"),
    ]);
  });

  it("moves unresolved host prompts to Recent when resolvedAt is set", () => {
    applyHostSnapshot([hostInterview("interview", 100, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );
    const { result: recent } = renderHook(() => useRecentNotificationIds());
    const { result: row } = renderHook(() =>
      useMergedNotificationRow(hostFeedId("interview")),
    );

    expect(attention.current).toEqual([hostFeedId("interview")]);
    expect(recent.current).toEqual([]);
    expect(row.current?.createdAt).toBe(100);
    expect(row.current?.resolvedAt).toBeNull();

    act(() => {
      applyHostSnapshot([hostInterview("interview", 100, 500)], {
        unreadCount: 1,
        attentionCount: 0,
      });
    });

    expect(attention.current).toEqual([]);
    expect(recent.current).toEqual([hostFeedId("interview")]);
    expect(row.current?.createdAt).toBe(100);
    expect(row.current?.resolvedAt).toBe(500);
  });

  it("moves unread failures to Recent when readAt is set (original timestamps preserved)", () => {
    applyHostSnapshot([hostFailure("fail", 42, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });
    seedAppLocal([appLocalEntry("app-fail", 33, null)]);

    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );
    const { result: recent } = renderHook(() => useRecentNotificationIds());
    const { result: hostRow } = renderHook(() =>
      useMergedNotificationRow(hostFeedId("fail")),
    );
    const { result: appRow } = renderHook(() =>
      useMergedNotificationRow(appLocalFeedId("app-fail")),
    );

    expect(attention.current).toEqual([
      hostFeedId("fail"),
      appLocalFeedId("app-fail"),
    ]);
    expect(recent.current).toEqual([]);
    expect(hostRow.current?.createdAt).toBe(42);
    expect(appRow.current?.createdAt).toBe(33);

    act(() => {
      applyHostSnapshot([hostFailure("fail", 42, 999)], {
        unreadCount: 0,
        attentionCount: 0,
      });
      useAppLocalNotificationsStore.getState().markAsRead("app-fail", 888);
    });

    expect(attention.current).toEqual([]);
    expect(recent.current).toEqual([
      hostFeedId("fail"),
      appLocalFeedId("app-fail"),
    ]);
    expect(hostRow.current?.createdAt).toBe(42);
    expect(hostRow.current?.readAt).toBe(999);
    expect(appRow.current?.createdAt).toBe(33);
    expect(appRow.current?.readAt).toBe(888);
  });

  it("orders Attention blocking-first regardless of relative timestamps", () => {
    applyHostSnapshot(
      [
        hostFailure("newer-failure", 1_000, null),
        hostPrompt("older-prompt", 10, null),
        hostFailure("mid-failure", 500, null),
        hostInterview("mid-prompt", 200, null),
      ],
      { unreadCount: 4, attentionCount: 4 },
    );
    seedAppLocal([appLocalEntry("app-fail", 2_000, null)]);

    const { result } = renderHook(() => useAttentionNotificationIds());

    expect(result.current).toEqual([
      hostFeedId("mid-prompt"),
      hostFeedId("older-prompt"),
      appLocalFeedId("app-fail"),
      hostFeedId("newer-failure"),
      hostFeedId("mid-failure"),
    ]);
  });
});

describe("Recent filters leave Attention invariant", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    resetPopoverFilters();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps Attention stable while unreadOnly and categories change Recent", () => {
    applyHostSnapshot(
      [
        hostPrompt("prompt", 100, null),
        hostDone("done-unread", 90, null),
        hostDone("done-read", 80, 10),
      ],
      { unreadCount: 2, attentionCount: 1 },
    );
    seedAppLocal([appLocalEntry("app-read", 70, 5)]);
    seedGlobal([globalEntry("collab", 60, null)]);

    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );
    const { result: recent } = renderHook(() => useRecentNotificationIds());

    const attentionBefore = [...attention.current];
    expect(attentionBefore).toEqual([hostFeedId("prompt")]);
    expect(recent.current).toEqual([
      hostFeedId("done-unread"),
      hostFeedId("done-read"),
      appLocalFeedId("app-read"),
      globalFeedId("collab"),
    ]);

    act(() => {
      useNotificationsPopoverStore.getState().setUnreadOnly(true);
    });
    expect(attention.current).toEqual(attentionBefore);
    expect(recent.current).toEqual([
      hostFeedId("done-unread"),
      globalFeedId("collab"),
    ]);

    act(() => {
      useNotificationsPopoverStore.getState().setUnreadOnly(false);
      useNotificationsPopoverStore.getState().toggleCategory("task");
    });
    expect(attention.current).toEqual(attentionBefore);
    expect(recent.current).toEqual([
      appLocalFeedId("app-read"),
      globalFeedId("collab"),
    ]);

    act(() => {
      useNotificationsPopoverStore.getState().toggleCategory("system");
      useNotificationsPopoverStore.getState().toggleCategory("collaboration");
    });
    expect(attention.current).toEqual(attentionBefore);
    expect(recent.current).toEqual([]);
  });

  it("resets unreadOnly and categories when setOpen(true)", () => {
    act(() => {
      useNotificationsPopoverStore.getState().setUnreadOnly(true);
      useNotificationsPopoverStore.getState().toggleCategory("task");
      useNotificationsPopoverStore.getState().toggleCategory("system");
    });

    expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(true);
    expect(useNotificationsPopoverStore.getState().categories.has("task")).toBe(
      false,
    );
    expect(
      useNotificationsPopoverStore.getState().categories.has("system"),
    ).toBe(false);

    act(() => {
      useNotificationsPopoverStore.getState().setOpen(true);
    });

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(false);
    expect(
      [...useNotificationsPopoverStore.getState().categories].sort(),
    ).toEqual([...ALL_NOTIFICATION_CATEGORIES].sort());

    act(() => {
      useNotificationsPopoverStore.getState().setUnreadOnly(true);
      useNotificationsPopoverStore.getState().toggleCategory("collaboration");
      useNotificationsPopoverStore.getState().setOpen(false);
    });

    // Closing must leave filters alone; only open resets.
    expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(true);
    expect(
      useNotificationsPopoverStore.getState().categories.has("collaboration"),
    ).toBe(false);
  });

  it("drops a global row from Recent immediately after store markAsRead while unreadOnly is active", () => {
    // Regression for the T03 review: reading global entries via the store
    // must invalidate the filtered Recent projection. Going through
    // useMergedNotificationsActions would mask a missing entries dep.
    seedGlobal([globalEntry("collab-unread", 60, null)]);

    act(() => {
      useNotificationsPopoverStore.getState().setUnreadOnly(true);
    });

    const { result: recent } = renderHook(() => useRecentNotificationIds());
    expect(recent.current).toEqual([globalFeedId("collab-unread")]);

    act(() => {
      useNotificationsStore.getState().markAsRead("collab-unread");
    });

    expect(recent.current).toEqual([]);
  });
});

describe("useNotificationBellState", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("sums host attentionCount with app-local unread for exact attention", () => {
    applyHostSnapshot([], { unreadCount: 0, attentionCount: 3 });
    seedAppLocal([
      appLocalEntry("a1", 10, null),
      appLocalEntry("a2", 20, null),
    ]);

    const { result } = renderHook(() => useNotificationBellState());
    expect(result.current).toEqual({ kind: "attention", count: 5 });
  });

  it("renders large attention counts without capping", () => {
    applyHostSnapshot([], { unreadCount: 0, attentionCount: 140 });
    seedAppLocal([
      appLocalEntry("a1", 1, null),
      appLocalEntry("a2", 2, null),
      appLocalEntry("a3", 3, null),
      appLocalEntry("a4", 4, null),
      appLocalEntry("a5", 5, null),
      appLocalEntry("a6", 6, null),
      appLocalEntry("a7", 7, null),
      appLocalEntry("a8", 8, null),
      appLocalEntry("a9", 9, null),
      appLocalEntry("a10", 10, null),
    ]);

    const { result } = renderHook(() => useNotificationBellState());
    expect(result.current).toEqual({ kind: "attention", count: 150 });
  });

  it("returns quietDot when there is unread activity but no attention", () => {
    applyHostSnapshot([hostDone("done", 10, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });
    seedGlobal([globalEntry("g1", 5, null)]);

    const { result } = renderHook(() => useNotificationBellState());
    expect(result.current).toEqual({ kind: "quietDot" });
  });

  it("returns clear when host summary is exact and every source is fully read", () => {
    applyHostSnapshot([hostDone("done", 10, 1)], {
      unreadCount: 0,
      attentionCount: 0,
    });
    seedAppLocal([appLocalEntry("app", 5, 1)]);
    seedGlobal([globalEntry("g1", 3, 1)]);

    const { result } = renderHook(() => useNotificationBellState());
    expect(result.current).toEqual({ kind: "clear" });
  });

  it("returns unknown whenever host summary is null, even with exact app/global unreads", () => {
    // Host store starts with summary null; leave it that way.
    seedAppLocal([appLocalEntry("app", 10, null)]);
    seedGlobal([globalEntry("g1", 5, null)]);

    const { result } = renderHook(() => useNotificationBellState());
    expect(result.current).toEqual({ kind: "unknown" });
    expect(useHostNotificationsStore.getState().summary).toBeNull();
  });

  it("produces an accessible label per bell state kind", () => {
    const cases: ReadonlyArray<{
      readonly state: NotificationBellState;
      readonly expected: string;
    }> = [
      {
        state: { kind: "unknown" },
        expected: "Notifications, task notification status unavailable",
      },
      { state: { kind: "clear" }, expected: "Notifications" },
      {
        state: { kind: "quietDot" },
        expected: "Notifications, unread activity",
      },
      {
        state: { kind: "attention", count: 1 },
        expected: "Notifications, 1 notification needs attention",
      },
      {
        state: { kind: "attention", count: 150 },
        expected: "Notifications, 150 notifications need attention",
      },
    ];

    for (const { state, expected } of cases) {
      const label = notificationBellAccessibleLabel(state);
      expect(label).toBe(expected);
      if (state.kind === "attention") {
        expect(label).toContain("attention");
        expect(label).toContain(String(state.count));
      } else {
        // Non-attention states must not expose a bare count with no context.
        expect(/\b\d+\b/.test(label)).toBe(false);
      }
    }
  });
});

describe("host unavailable / partial center state", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    resetPopoverFilters();
    window.localStorage.clear();
    activeHostIdRef.value = null;
    directoryRef.value = {
      findById: () => null,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("still surfaces app-local and global rows when host summary is null", () => {
    seedAppLocal([appLocalEntry("app", 20, null)]);
    seedGlobal([globalEntry("collab", 10, null)]);

    const { result: recent } = renderHook(() => useRecentNotificationIds());
    const { result: all } = renderHook(() => useMergedNotificationIds());
    const { result: attention } = renderHook(() =>
      useAttentionNotificationIds(),
    );

    expect(all.current).toEqual([
      appLocalFeedId("app"),
      globalFeedId("collab"),
    ]);
    // Unread app-local failure is still attention-eligible without a host.
    expect(attention.current).toEqual([appLocalFeedId("app")]);
    expect(recent.current).toEqual([globalFeedId("collab")]);
  });

  it("marks center host state partial when active host id is null", () => {
    const { result } = renderHook(() => useNotificationCenterHostState());
    expect(result.current).toEqual({
      hostLabel: null,
      isPartial: true,
    });
  });

  it("marks center host state partial when summary is null even with an active host", () => {
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };

    const { result } = renderHook(() => useNotificationCenterHostState());
    expect(result.current.isPartial).toBe(true);
    expect(result.current.hostLabel).toBe(mockLocalHostEntry.label);
  });

  it("clears partial when host is active and summary has landed", () => {
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    applyHostSnapshot([], { unreadCount: 0, attentionCount: 0 });

    const { result } = renderHook(() => useNotificationCenterHostState());
    expect(result.current).toEqual({
      hostLabel: mockLocalHostEntry.label,
      isPartial: false,
    });
  });
});

describe("row category and resolvedAt projection fields", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("projects category and resolvedAt from each source", () => {
    applyHostSnapshot(
      [hostPrompt("prompt", 30, null), hostFailure("fail", 20, null)],
      { unreadCount: 2, attentionCount: 2 },
    );
    seedAppLocal([appLocalEntry("app", 15, null)]);
    seedGlobal([globalEntry("g", 10, null)]);

    const { result: prompt } = renderHook(() =>
      useMergedNotificationRow(hostFeedId("prompt")),
    );
    const { result: fail } = renderHook(() =>
      useMergedNotificationRow(hostFeedId("fail")),
    );
    const { result: app } = renderHook(() =>
      useMergedNotificationRow(appLocalFeedId("app")),
    );
    const { result: global } = renderHook(() =>
      useMergedNotificationRow(globalFeedId("g")),
    );

    const expected: ReadonlyArray<{
      readonly row: typeof prompt.current;
      readonly category: NotificationCategory;
      readonly resolvedAt: number | null;
    }> = [
      { row: prompt.current, category: "task", resolvedAt: null },
      { row: fail.current, category: "task", resolvedAt: null },
      { row: app.current, category: "system", resolvedAt: null },
      { row: global.current, category: "collaboration", resolvedAt: null },
    ];

    for (const item of expected) {
      expect(item.row?.category).toBe(item.category);
      expect(item.row?.resolvedAt).toBe(item.resolvedAt);
    }
  });
});
