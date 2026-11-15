import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";

const hooks = vi.hoisted(() => ({
  response: null as AccountNotificationSettingsResponse | null,
  matrixMutate: vi.fn(),
  hooksMutate: vi.fn(),
}));

vi.mock("@/hooks/notifications/use-account-notification-settings", () => ({
  useAccountNotificationSettings: () => ({
    data: hooks.response ?? undefined,
    error: null,
    isLoading: false,
    isFetching: false,
  }),
  useAccountNotificationMatrixSave: () => ({
    mutate: hooks.matrixMutate,
    isPending: false,
    error: null,
  }),
  useAccountNotificationHooksSave: () => ({
    mutate: hooks.hooksMutate,
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
  hooks.matrixMutate.mockClear();
  hooks.hooksMutate.mockClear();
});

describe("account Notifications settings", () => {
  it("shows the account defaults before a notification row has been saved", () => {
    hooks.response = { revision: null, settings: null };

    render(<NotificationsSettingsPanel />);

    expect(
      screen
        .getByRole("switch", {
          name: "Needs action In-app notifications",
        })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("switch", {
          name: "Failure In-app notifications",
        })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("switch", {
          name: "Done In-app notifications",
        })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("switch", {
          name: "Info In-app notifications",
        })
        .getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("opens and saves the account policy with no computer selected or online", () => {
    hooks.response = {
      revision: 4,
      settings: { matrix: initialMatrix, hooks: [] },
    };

    render(<NotificationsSettingsPanel />);

    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(
      screen.getByText(
        "Which events you're told about, and what your automation receives. Choose chimes under Application → Sounds; manage banners in your operating system's notification settings.",
      ),
    ).toBeTruthy();
    const policy = screen.getByTestId("notifications-severity-policy");
    const switches = within(policy).getAllByRole("switch");
    expect(switches).toHaveLength(4);
    expect(
      screen.queryByRole("switch", {
        name: "Alert when a turn runs longer than",
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    expect(screen.queryByText(/notification-hooks\.json/)).toBeNull();

    fireEvent.click(
      within(policy).getByRole("switch", {
        name: "Done In-app notifications",
      }),
    );

    expect(hooks.matrixMutate).toHaveBeenCalledTimes(1);
    expect(hooks.matrixMutate).toHaveBeenCalledWith({
      matrix: {
        ...initialMatrix,
        done: { renderer: true },
      },
      revision: 4,
    });
  });
});
