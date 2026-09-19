import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { makeMergedNotificationRow } from "@/lib/home-focus/__tests__/fixtures";

const rowsState = vi.hoisted<{ current: ReadonlyArray<unknown> }>(() => ({
  current: [],
}));
const markAsRead = vi.hoisted(() => vi.fn<(row: unknown) => void>());
const actionsState = vi.hoisted<{ current: (row: unknown) => void }>(() => ({
  current: () => {},
}));

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationRows: () => rowsState.current,
  useMergedNotificationsActions: () => ({ markAsRead: actionsState.current }),
}));

import {
  browserAttentionMatches,
  useBrowserAttention,
  useConsumeBrowserAttention,
  type BrowserAttentionTarget,
} from "@/hooks/notifications/use-browser-attention";

const TARGET: BrowserAttentionTarget = {
  epicId: "epic-1",
  hostId: "host-1",
  sessionId: "session-1",
  tabId: "tab-1",
};

function row(overrides: Partial<MergedNotificationRow>): MergedNotificationRow {
  return makeMergedNotificationRow({
    feedId: "host:b1",
    hostKind: "browser.human.needed",
    severity: "needs_action",
    originHostId: "host-1",
    payload: {
      kind: "browserSession",
      epicId: "epic-1",
      sessionId: "session-1",
      tabId: "tab-1",
    },
    ...overrides,
  });
}

function setFocus(visible: boolean, focused: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

describe("browserAttentionMatches", () => {
  it("matches an unread unresolved row for the exact target", () => {
    expect(browserAttentionMatches(row({}), TARGET)).toBe(true);
  });

  it.each([
    ["epic", { epicId: "other" }],
    ["host", { hostId: "other" }],
    ["session", { sessionId: "other" }],
    ["tab", { tabId: "other" }],
  ])("does not match a different %s", (_name, override) => {
    expect(browserAttentionMatches(row({}), { ...TARGET, ...override })).toBe(
      false,
    );
  });

  it("excludes read and resolved rows", () => {
    expect(browserAttentionMatches(row({ readAt: 5 }), TARGET)).toBe(false);
    expect(browserAttentionMatches(row({ resolvedAt: 5 }), TARGET)).toBe(false);
  });

  it("ignores other kinds", () => {
    expect(
      browserAttentionMatches(row({ hostKind: "approval.requested" }), TARGET),
    ).toBe(false);
  });
});

describe("useBrowserAttention", () => {
  it("reflects whether any row matches", () => {
    rowsState.current = [row({})];
    expect(renderHook(() => useBrowserAttention(TARGET)).result.current).toBe(
      true,
    );
    rowsState.current = [row({ readAt: 1 })];
    expect(renderHook(() => useBrowserAttention(TARGET)).result.current).toBe(
      false,
    );
  });
});

describe("useConsumeBrowserAttention", () => {
  beforeEach(() => {
    markAsRead.mockReset();
    actionsState.current = (r) => markAsRead(r);
    rowsState.current = [row({})];
    setFocus(true, true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the matching row read when active, visible and focused", () => {
    renderHook(() => useConsumeBrowserAttention(TARGET, true));
    expect(markAsRead).toHaveBeenCalledTimes(1);
    expect(markAsRead).toHaveBeenCalledWith(rowsState.current[0]);
  });

  it("does nothing when inactive", () => {
    renderHook(() => useConsumeBrowserAttention(TARGET, false));
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("waits for document focus, then consumes on the focus event", () => {
    setFocus(true, false);
    renderHook(() => useConsumeBrowserAttention(TARGET, true));
    expect(markAsRead).not.toHaveBeenCalled();
    setFocus(true, true);
    window.dispatchEvent(new Event("focus"));
    expect(markAsRead).toHaveBeenCalledTimes(1);
  });

  it("waits for visibility, then consumes on visibilitychange", () => {
    setFocus(false, true);
    renderHook(() => useConsumeBrowserAttention(TARGET, true));
    expect(markAsRead).not.toHaveBeenCalled();
    setFocus(true, true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(markAsRead).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners on unmount", () => {
    setFocus(true, false);
    const { unmount } = renderHook(() =>
      useConsumeBrowserAttention(TARGET, true),
    );
    unmount();
    setFocus(true, true);
    window.dispatchEvent(new Event("focus"));
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("does not re-mark an occurrence when the actions identity changes", () => {
    const { rerender } = renderHook(() =>
      useConsumeBrowserAttention(TARGET, true),
    );
    expect(markAsRead).toHaveBeenCalledTimes(1);
    actionsState.current = (r) => markAsRead(r);
    rerender();
    expect(markAsRead).toHaveBeenCalledTimes(1);
  });

  it("consumes a newer occurrence of the same feed row", () => {
    const { rerender } = renderHook(() =>
      useConsumeBrowserAttention(TARGET, true),
    );
    const newer = row({ createdAt: 99 });
    rowsState.current = [newer];
    actionsState.current = (r) => markAsRead(r);
    rerender();
    expect(markAsRead).toHaveBeenCalledTimes(2);
    expect(markAsRead).toHaveBeenLastCalledWith(newer);
  });

  it("does not consume rows for another tab", () => {
    rowsState.current = [
      row({
        payload: {
          kind: "browserSession",
          epicId: "epic-1",
          sessionId: "session-1",
          tabId: "tab-2",
        },
      }),
    ];
    renderHook(() => useConsumeBrowserAttention(TARGET, true));
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
