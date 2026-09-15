import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { countPendingPromptRows } from "@/lib/home-focus/focus-prompts";
import {
  makeApprovalPayload,
  makeMergedNotificationRow,
} from "@/lib/home-focus/__tests__/fixtures";
import { useHomeBadgeCount } from "@/components/home-focus/use-home-badge-count";

/**
 * Regression guard for the always-on-join fix: `useHomeBadgeCount` must be
 * cheap enough to mount for the life of the window, so it reads
 * `useMergedNotificationRows` directly rather than joining through
 * `useFocusModel`. Mocking ONLY that one store here - no activity store, no
 * chat-session/open-epic registry, no host query - is the test itself: if the
 * hook regressed back to calling `useFocusModel()`, this file would need every
 * mock `use-focus-model.test.tsx` needs and would fail to render without them.
 */
const { notificationRowsMock } = vi.hoisted(() => ({
  notificationRowsMock: vi.fn<() => ReadonlyArray<MergedNotificationRow>>(
    () => [],
  ),
}));

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationRows: notificationRowsMock,
}));

afterEach(() => {
  cleanup();
  notificationRowsMock.mockReturnValue([]);
});

describe("useHomeBadgeCount", () => {
  it("equals countPendingPromptRows(rows) while depending on nothing but the merged-notifications store", () => {
    const eligible = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const ineligible = makeMergedNotificationRow({
      feedId: "host:stopped-1",
      hostKind: "agent.stopped",
      severity: "failure",
    });
    const rows = [eligible, ineligible];
    notificationRowsMock.mockReturnValue(rows);

    const { result } = renderHook(() => useHomeBadgeCount());

    expect(result.current).toBe(countPendingPromptRows(rows));
    expect(result.current).toBe(1);
  });

  it("is 0 for an empty feed", () => {
    notificationRowsMock.mockReturnValue([]);

    const { result } = renderHook(() => useHomeBadgeCount());

    expect(result.current).toBe(0);
  });
});
