import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { setMobileApp } from "@/lib/mobile-app";

const mocks = vi.hoisted(() => ({
  data: null as AuthenticatedUser | null,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(() => Promise.resolve({})),
  openLink: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: mocks.data,
    isPending: mocks.isPending,
    isError: mocks.isError,
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));

vi.mock("@/hooks/auth/use-platform-billing-url", () => ({
  usePlatformBillingUrl: () => "https://traycer.ai/billing",
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://traycer.ai/sign-in" }),
}));

import { CreditsSettingsPanel } from "../credits-settings-panel";

describe("CreditsSettingsPanel", () => {
  beforeEach(() => {
    mocks.data = null;
    mocks.isPending = false;
    mocks.isError = false;
    mocks.isFetching = false;
    mocks.openLink.mockClear();
    mocks.refetch.mockClear();
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("shows only $0.00 left and Add credits at a zero balance, with the subtitle once", () => {
    mocks.data = userWith(
      userSubscription({
        totalPlanCredits: 0,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-ready").textContent).toBe(
      "$0.00 leftAdd credits",
    );
    expect(screen.getAllByText("Your remaining credits.")).toHaveLength(1);
  });

  it("counts credits, not dollars, in the installed app, with no Add credits", () => {
    setMobileApp(true);
    mocks.data = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 30,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-remaining").textContent).toMatch(
      /^[\d,.]+ credits left$/,
    );
    expect(screen.queryByRole("button", { name: /Add credits/ })).toBeNull();
  });

  it("says the read failed, with Retry and the report link", () => {
    mocks.isError = true;

    render(<CreditsSettingsPanel />);

    const failure = screen.getByTestId("credits-error");
    expect(failure.textContent).toContain("Couldn't read your credits.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your credits/)).toBeNull();
  });

  it("renders the remaining balance at a positive credit amount", () => {
    mocks.data = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 30,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-ready").textContent).toBe(
      "$70.00 leftAdd credits",
    );
  });

  it("opens the dashboard billing page as an account link", () => {
    mocks.data = userWith(
      userSubscription({
        totalPlanCredits: 0,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );

    render(<CreditsSettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add credits/ }));

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://traycer.ai/billing",
      "account",
      expect.objectContaining({ type: "click" }),
    );
  });
});
