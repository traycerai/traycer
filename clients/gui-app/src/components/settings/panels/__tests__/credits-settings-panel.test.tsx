import type {
  AuthenticatedUser,
  AuthenticatedUserCampaignCredit,
} from "@traycer/protocol/auth";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { setMobileApp } from "@/lib/mobile-app";
import { useAccountContextStore } from "@/stores/auth/account-context-store";

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
    expect(
      screen.getAllByText("Credits pay for your sandboxes, awake or resting."),
    ).toHaveLength(1);
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

describe("CreditsSettingsPanel credit offers", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function offer(
    overrides: Partial<AuthenticatedUserCampaignCredit>,
  ): AuthenticatedUserCampaignCredit {
    return {
      campaignId: "c1",
      name: "Launch offer",
      description: "For the launch models",
      grantCredits: 25,
      remainingCredits: 12.5,
      // Five days and an hour out, so the phrase rounds to "5 days" for the
      // whole run.
      endsAt: new Date(Date.now() + 5 * DAY_MS + 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  }

  function userWithOffers(
    campaignCredits: AuthenticatedUserCampaignCredit[] | undefined,
  ): AuthenticatedUser {
    return {
      ...userWith(
        userSubscription({
          totalPlanCredits: 100,
          consumedFromPlan: 30,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [],
      ),
      campaignCredits,
    };
  }

  beforeEach(() => {
    mocks.data = null;
    mocks.isPending = false;
    mocks.isError = false;
    mocks.isFetching = false;
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
  });

  it("shows no offers in a team context", () => {
    mocks.data = {
      ...userWithOffers([offer({})]),
      teamSubscriptions: [teamSubscription(100)],
    };
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-1" },
    });

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-ready")).toBeTruthy();
    expect(screen.queryByTestId("credits-offers")).toBeNull();
  });

  it.each([undefined, []])(
    "renders no offers section when campaignCredits is %j",
    (campaignCredits) => {
      mocks.data = userWithOffers(campaignCredits);

      render(<CreditsSettingsPanel />);

      expect(screen.getByTestId("credits-ready")).toBeTruthy();
      expect(screen.queryByTestId("credits-offers")).toBeNull();
    },
  );

  it("leaves out an offer that has already ended, and the section with it", () => {
    mocks.data = userWithOffers([
      offer({ endsAt: new Date(Date.now() - 60 * 1000).toISOString() }),
    ]);

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-ready")).toBeTruthy();
    expect(screen.queryByTestId("credits-offers")).toBeNull();
  });

  it("lists each offer in dollars with its name, description and time left", () => {
    mocks.data = userWithOffers([
      offer({}),
      offer({
        campaignId: "c2",
        name: "Plain offer",
        description: null,
        grantCredits: 10,
        remainingCredits: 4,
      }),
    ]);

    render(<CreditsSettingsPanel />);

    const rows = screen.getAllByTestId("credits-offer-row");
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(
      first.querySelector("[data-testid=credits-offer-remaining]")?.textContent,
    ).toBe("$12.50");
    expect(
      first.querySelector("[data-testid=credits-offer-grant]")?.textContent,
    ).toBe("of $25.00");
    expect(first.textContent).toContain("Launch offer");
    expect(first.textContent).toContain("For the launch models");
    expect(
      first.querySelector("[data-testid=credits-offer-time-left]")?.textContent,
    ).toBe("5 days left");
    // A null description adds no line: the row is figures, name and time.
    expect(second.textContent).toBe("$4.00of $10.00Plain offer5 days left");
  });

  it("counts offers in credits, not dollars, in the installed app", () => {
    setMobileApp(true);
    mocks.data = userWithOffers([offer({})]);

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-offer-remaining").textContent).toBe(
      "12.50 credits",
    );
    expect(screen.getByTestId("credits-offer-grant").textContent).toBe(
      "of 25.00 credits",
    );
  });

  it("keeps offer credit out of the balance", () => {
    mocks.data = userWithOffers([offer({ remainingCredits: 12.5 })]);

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-remaining").textContent).toBe(
      "$70.00 left",
    );
    expect(screen.getByTestId("credits-offer-remaining").textContent).toBe(
      "$12.50",
    );
  });

  it("explains the terms from the About credit offers button", () => {
    mocks.data = userWithOffers([offer({})]);

    render(<CreditsSettingsPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "About credit offers" }),
    );

    expect(
      screen.getByText(
        "Separate from your total credits, and only for each offer's models. Unused credit expires when the offer ends.",
      ),
    ).toBeTruthy();
  });
});
