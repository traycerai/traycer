import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectProfile } from "@/lib/profiles/types";
import { RootLandingPage } from "../root-landing-page";

const mockUseAuthStore = vi.hoisted(() =>
  vi.fn((selector: (s: { status: string }) => unknown) =>
    selector({ status: "signed-out" }),
  ),
);
const mockUseActiveProjectProfile = vi.hoisted(() =>
  vi.fn((): ProjectProfile | null => null),
);

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (s: { status: string }) => unknown) =>
    mockUseAuthStore(selector),
}));

vi.mock("@/lib/profiles/use-active-project-profile", () => ({
  useActiveProjectProfile: () => mockUseActiveProjectProfile(),
}));

vi.mock("@/components/auth/auth-landing-page", () => ({
  AuthLandingPage: () => <div data-testid="auth-landing">auth</div>,
}));

vi.mock("@/components/profiles/all-projects-home", () => ({
  AllProjectsHome: () => <div data-testid="all-projects-home">all</div>,
}));

vi.mock("@/components/profiles/profile-launch-landing", () => ({
  ProfileLaunchLanding: () => (
    <div data-testid="profile-launch-landing">launch</div>
  ),
}));

describe("RootLandingPage", () => {
  beforeEach(() => {
    mockUseAuthStore.mockImplementation(
      (selector: (s: { status: string }) => unknown) =>
        selector({ status: "signed-out" }),
    );
    mockUseActiveProjectProfile.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("signed-out → AuthLandingPage", async () => {
    render(<RootLandingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("auth-landing")).toBeTruthy();
    });
    expect(screen.queryByTestId("all-projects-home")).toBeNull();
    expect(screen.queryByTestId("profile-launch-landing")).toBeNull();
  });

  it("signed-in + null profile → AllProjectsHome", async () => {
    mockUseAuthStore.mockImplementation(
      (selector: (s: { status: string }) => unknown) =>
        selector({ status: "signed-in" }),
    );
    mockUseActiveProjectProfile.mockReturnValue(null);

    render(<RootLandingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("all-projects-home")).toBeTruthy();
    });
    expect(screen.queryByTestId("auth-landing")).toBeNull();
    expect(screen.queryByTestId("profile-launch-landing")).toBeNull();
  });

  it("signed-in + active profile → ProfileLaunchLanding", async () => {
    mockUseAuthStore.mockImplementation(
      (selector: (s: { status: string }) => unknown) =>
        selector({ status: "signed-in" }),
    );
    mockUseActiveProjectProfile.mockReturnValue({
      id: "p1",
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/a", hostId: "h1" }],
      assignedEpicIds: [],
      createdAt: 0,
      updatedAt: 0,
    });

    render(<RootLandingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("profile-launch-landing")).toBeTruthy();
    });
    expect(screen.queryByTestId("auth-landing")).toBeNull();
    expect(screen.queryByTestId("all-projects-home")).toBeNull();
  });
});
