import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";

const hooks = vi.hoisted(() => ({
  response: null as AccountNotificationSettingsResponse | null,
}));

vi.mock("@/hooks/notifications/use-account-notification-settings", () => ({
  useAccountNotificationSettings: () => ({
    data: hooks.response ?? undefined,
    error: null,
    isLoading: false,
    isFetching: false,
  }),
  useAccountNotificationHooksSave: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return { ...actual, useCloudChatViewerId: () => "viewer-1" };
});

const initialMatrix = {
  needs_action: { renderer: true },
  failure: { renderer: true },
  done: { renderer: false },
  info: { renderer: false },
};

afterEach(() => {
  cleanup();
  hooks.response = null;
});

describe("account Notifications settings", () => {
  it("opens the account page with no computer selected or online", () => {
    hooks.response = {
      revision: 4,
      settings: { matrix: initialMatrix, hooks: [] },
    };

    render(<NotificationsSettingsPanel />);

    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(
      screen.getByText(
        "What your automation receives when a host creates a notification. Choose which kinds interrupt you under Application → Alerts.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("cloud-notification-hooks-manager")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    expect(screen.queryByText(/notification-hooks\.json/)).toBeNull();
  });
});
