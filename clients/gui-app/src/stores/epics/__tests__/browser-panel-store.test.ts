import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBrowserPanelPreferences,
  useBrowserPanelStore,
} from "../browser-panel-store";

function signIn(userId: string): void {
  useAuthStore.setState({
    profile: { userId, userName: userId, email: `${userId}@example.com` },
  });
}

describe("browser panel preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useBrowserPanelStore.setState({ preferences: {}, legacyHostByScope: {} });
    signIn("user-a");
  });

  it("starts every device expanded with offline devices hidden", () => {
    const { result } = renderHook(() => useBrowserPanelPreferences("epic-1"));
    expect(result.current.showOffline).toBe(false);
    expect(result.current.collapsed).toEqual({});
    expect(result.current.legacyHostId).toBeNull();
  });

  it("remembers a collapsed device and the offline toggle per user and task", () => {
    const first = renderHook(() => useBrowserPanelPreferences("epic-1"));
    act(() => {
      first.result.current.setCollapsed("host-2", true);
      first.result.current.setShowOffline(true);
    });
    expect(first.result.current.collapsed).toEqual({ "host-2": true });
    expect(first.result.current.showOffline).toBe(true);

    const otherTask = renderHook(() => useBrowserPanelPreferences("epic-2"));
    expect(otherTask.result.current.collapsed).toEqual({});
    expect(otherTask.result.current.showOffline).toBe(false);

    act(() => signIn("user-b"));
    const otherUser = renderHook(() => useBrowserPanelPreferences("epic-1"));
    expect(otherUser.result.current.collapsed).toEqual({});
    expect(otherUser.result.current.showOffline).toBe(false);

    act(() => signIn("user-a"));
    const back = renderHook(() => useBrowserPanelPreferences("epic-1"));
    expect(back.result.current.collapsed).toEqual({ "host-2": true });
  });

  it("re-expanding one device leaves the other collapsed devices alone", () => {
    const { result } = renderHook(() => useBrowserPanelPreferences("epic-1"));
    act(() => {
      result.current.setCollapsed("host-2", true);
      result.current.setCollapsed("host-3", true);
      result.current.setCollapsed("host-2", false);
    });
    expect(result.current.collapsed).toEqual({
      "host-2": false,
      "host-3": true,
    });
  });

  it("persists preferences but never an explicit legacy device choice", () => {
    const { result } = renderHook(() => useBrowserPanelPreferences("epic-1"));
    act(() => {
      result.current.setCollapsed("host-2", true);
      result.current.setLegacyHost("host-9");
    });
    expect(result.current.legacyHostId).toBe("host-9");

    const stored = window.localStorage.getItem(
      Object.keys(window.localStorage).find((key) =>
        key.includes("browser-panel"),
      ) ?? "",
    );
    expect(stored).not.toBeNull();
    expect(stored).toContain("host-2");
    expect(stored).not.toContain("host-9");
  });
});
