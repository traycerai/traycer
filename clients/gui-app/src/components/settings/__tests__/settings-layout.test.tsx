import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/components/layout/root-landing-page", () => ({
  RootLandingPage: () => <div data-testid="settings-auth-fallback" />,
}));

import { SettingsLayout } from "@/components/settings/settings-layout";

describe("<SettingsLayout />", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("renders the signed-out fallback instead of a blank settings deep link", () => {
    render(<SettingsLayout />);

    expect(screen.getByTestId("settings-auth-fallback")).not.toBeNull();
  });

  it("leaves signed-in settings to the top-level tab host", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "User One",
        email: "user@example.com",
      },
      { userId: "user-1", username: "user-one" },
      [],
    );

    render(<SettingsLayout />);

    expect(screen.queryByTestId("settings-auth-fallback")).toBeNull();
  });
});
