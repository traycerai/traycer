import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/components/auth/auth-landing-page", () => ({
  AuthLandingPage: () => <div data-testid="auth-landing-stub">auth</div>,
}));

vi.mock("@/components/home/home-page", () => ({
  HomePage: () => <div data-testid="home-page-stub">home</div>,
}));

import { RootLandingPage } from "@/components/layout/root-landing-page";

describe("RootLandingPage", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("renders the auth landing page while signed out", () => {
    render(<RootLandingPage />);

    expect(screen.queryByTestId("auth-landing-stub")).not.toBeNull();
    expect(screen.queryByTestId("home-page-stub")).toBeNull();
  });

  it("keeps the auth landing page visible while an auth attempt is in flight", () => {
    useAuthStore.getState().setSigningIn();

    render(<RootLandingPage />);

    expect(screen.queryByTestId("auth-landing-stub")).not.toBeNull();
    expect(screen.queryByTestId("home-page-stub")).toBeNull();
  });

  it("renders the normal landing workspace after sign-in", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );

    render(<RootLandingPage />);

    expect(screen.queryByTestId("auth-landing-stub")).toBeNull();
    expect(screen.queryByTestId("home-page-stub")).not.toBeNull();
  });
});
