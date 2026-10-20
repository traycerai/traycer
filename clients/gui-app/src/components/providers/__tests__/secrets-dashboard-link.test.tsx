import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManagedCredentialsLine } from "@/components/providers/secrets-dashboard-link";

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({
    signInUrl: "https://platform.example.dev/sign-in?x=1",
  }),
}));

afterEach(() => {
  cleanup();
  mocks.openLink.mockReset();
});

describe("<AccountManagedCredentialsLine />", () => {
  it("renders the line with a Secrets and GitHub button", () => {
    render(<AccountManagedCredentialsLine />);

    expect(screen.getByTestId("credentials-managed-in-account")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Secrets and GitHub" }),
    ).toBeTruthy();
  });

  it("opens the secrets dashboard as an account link when the button is clicked", () => {
    mocks.openLink.mockResolvedValue(undefined);
    render(<AccountManagedCredentialsLine />);

    fireEvent.click(screen.getByRole("button", { name: "Secrets and GitHub" }));

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.example.dev/environments/personal/secrets",
      "account",
      expect.anything(),
    );
  });
});
