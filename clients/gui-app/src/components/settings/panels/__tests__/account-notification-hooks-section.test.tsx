import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountNotificationHook,
  AccountNotificationSettingsResponse,
} from "@traycer-clients/shared/environment/account-notification-schemas";
import { AccountNotificationHooksSection } from "@/components/settings/panels/account-notification-hooks-section";

const saveMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  error: null,
  reset: vi.fn(),
}));

vi.mock("@/hooks/notifications/use-account-notification-settings", () => ({
  useAccountNotificationHooksSave: () => saveMutation,
}));

const literalHook: AccountNotificationHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http",
    url: "https://hooks.example/builds",
    headers: { authorization: "Bearer typed-token" },
  },
  held: true,
};

const templatedHook: AccountNotificationHook = {
  id: "computer-token",
  name: "Computer token",
  enabled: true,
  severities: null,
  action: {
    type: "http",
    url: "https://hooks.example/templated",
    headers: { authorization: "Bearer $BUILD_TOKEN" },
  },
  held: false,
};

const commandHook: AccountNotificationHook = {
  id: "script",
  name: "Script hook",
  enabled: true,
  severities: null,
  action: {
    type: "command",
    command: "/usr/local/bin/notify",
    args: [],
    os: "darwin",
  },
  held: false,
};

const accountSettings = {
  matrix: {
    needs_action: { renderer: true },
    failure: { renderer: true },
    done: { renderer: true },
    info: { renderer: false },
  },
  hooks: [literalHook, templatedHook, commandHook],
};

const account: AccountNotificationSettingsResponse = {
  revision: 7,
  settings: accountSettings,
};

afterEach(() => {
  cleanup();
  saveMutation.mutate.mockClear();
  saveMutation.reset.mockClear();
});

describe("account notification hooks", () => {
  it("shows and sends only literal HTTP hooks, clearing legacy held on save", async () => {
    render(<AccountNotificationHooksSection account={account} />);

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    expect(within(manager).getByText("Build alerts")).toBeTruthy();
    expect(
      within(manager).getByText("https://hooks.example/builds"),
    ).toBeTruthy();
    expect(within(manager).queryByText("Computer token")).toBeNull();
    expect(
      within(manager).queryByText("https://hooks.example/templated"),
    ).toBeNull();
    expect(within(manager).queryByText("Script hook")).toBeNull();
    expect(within(manager).queryByText("/usr/local/bin/notify")).toBeNull();

    fireEvent.click(within(manager).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts updated" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));

    await waitFor(() => {
      expect(saveMutation.mutate).toHaveBeenCalledTimes(1);
    });
    expect(saveMutation.mutate.mock.calls[0]?.[0]).toEqual({
      hooks: [
        {
          id: "build-alerts",
          name: "Build alerts updated",
          enabled: true,
          severities: null,
          action: literalHook.action,
          held: false,
        },
      ],
      revision: 7,
    });
  });

  it("shows no sentence in an empty account list", () => {
    render(
      <AccountNotificationHooksSection
        account={{ ...account, settings: { ...accountSettings, hooks: [] } }}
      />,
    );

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    expect(
      within(manager).getByRole("button", { name: "Add hook" }),
    ).toBeTruthy();
    expect(within(manager).queryByText("No notification hooks")).toBeNull();
    expect(within(manager).queryByText(/Each hook is sent/)).toBeNull();
  });

  it("uses the account Delete confirmation words from board C30", async () => {
    render(
      <AccountNotificationHooksSection
        account={{
          ...account,
          settings: { ...accountSettings, hooks: [literalHook] },
        }}
      />,
    );

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText("Delete hook?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        '"Build alerts" will stop being sent from your computers.',
      ),
    ).toBeTruthy();
  });
});
