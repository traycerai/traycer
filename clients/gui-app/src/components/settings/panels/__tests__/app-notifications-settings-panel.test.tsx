import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
}));

afterEach(() => {
  cleanup();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

describe("<AppNotificationsSettingsPanel />", () => {
  it("holds only the soundtrack: no chime selects, no notification switches", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AppNotificationsSettingsPanel />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Sounds" })).toBeTruthy();
    expect(screen.getByText("Music while you work.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Music" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /sound$/ })).toBeNull();
    expect(screen.queryByTestId("notification-chime-section")).toBeNull();
  });
});
