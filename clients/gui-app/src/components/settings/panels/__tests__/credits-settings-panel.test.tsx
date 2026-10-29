import type {
  AuthenticatedUser,
  AuthenticatedUserCampaignCredit,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { CreditOffer } from "@traycer/protocol/auth/credit-offers";
import type {
  ClaimCreditOfferFetchResult,
  ListCreditOffersFetchResult,
} from "@traycer-clients/shared/auth/credit-offers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { setMobileApp } from "@/lib/mobile-app";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { CREDITS_PAGE } from "../credits-settings.definitions";

const mocks = vi.hoisted(() => ({
  data: null as AuthenticatedUser | null,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(() => Promise.resolve({})),
  openLink: vi.fn(() => Promise.resolve()),
  auth: {
    listCreditOffers:
      vi.fn<(signal: AbortSignal) => Promise<ListCreditOffersFetchResult>>(),
    claimCreditOffer:
      vi.fn<(campaignId: string) => Promise<ClaimCreditOfferFetchResult>>(),
  },
  toastFromAuthError: vi.fn<(error: unknown, fallback: string) => void>(),
}));

vi.mock("@/lib/host", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/host")>()),
  useAuthService: () => mocks.auth,
}));

vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
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

let queryClient: QueryClient;

function renderPanel(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <CreditsSettingsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.auth.listCreditOffers.mockReset();
  mocks.auth.listCreditOffers.mockResolvedValue({ kind: "ok", offers: [] });
  mocks.auth.claimCreditOffer.mockReset();
  mocks.toastFromAuthError.mockReset();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "u1", userName: "Ada", email: "ada@example.com" },
      { userId: "u1", username: "ada" },
      [],
    );
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
});

afterEach(() => {
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
});

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

    renderPanel();

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

    renderPanel();

    expect(screen.getByTestId("credits-remaining").textContent).toMatch(
      /^[\d,.]+ credits left$/,
    );
    expect(screen.queryByRole("button", { name: /Add credits/ })).toBeNull();
  });

  it("says the read failed, with Retry and the report link", () => {
    mocks.isError = true;

    renderPanel();

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

    renderPanel();

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

    renderPanel();
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
  });

  it("neither asks for nor shows offers in a team context", () => {
    mocks.data = {
      ...userWithOffers([offer({})]),
      teamSubscriptions: [teamSubscription(100)],
    };
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-1" },
    });

    renderPanel();

    expect(screen.getByTestId("credits-ready")).toBeTruthy();
    expect(screen.queryByTestId("credits-offers")).toBeNull();
    expect(mocks.auth.listCreditOffers).not.toHaveBeenCalled();
  });

  it.each([undefined, []])(
    "renders no offers section when campaignCredits is %j",
    (campaignCredits) => {
      mocks.data = userWithOffers(campaignCredits);

      renderPanel();

      expect(screen.getByTestId("credits-ready")).toBeTruthy();
      expect(screen.queryByTestId("credits-offers")).toBeNull();
    },
  );

  it("removes an offer that ends while the panel stays open", () => {
    vi.useFakeTimers();
    try {
      mocks.data = userWithOffers([
        offer({ endsAt: new Date(Date.now() + 60_000).toISOString() }),
      ]);

      renderPanel();
      expect(screen.getByTestId("credits-offer-row")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });

      expect(screen.queryByTestId("credits-offers")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves out an offer that has already ended, and the section with it", () => {
    mocks.data = userWithOffers([
      offer({ endsAt: new Date(Date.now() - 60 * 1000).toISOString() }),
    ]);

    renderPanel();

    expect(screen.getByTestId("credits-ready")).toBeTruthy();
    expect(screen.queryByTestId("credits-offers")).toBeNull();
  });

  it("lists each offer in dollars with its name, description and time left", () => {
    const launch = offer({});
    mocks.data = userWithOffers([
      launch,
      offer({
        campaignId: "c2",
        name: "Plain offer",
        description: null,
        grantCredits: 10,
        remainingCredits: 4,
      }),
    ]);

    renderPanel();

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
    // The bar is the share left: 12.50 of 25.
    expect(
      first.querySelector<HTMLElement>('[aria-hidden="true"] > div')?.style
        .width,
    ).toBe("50%");
    const timeLeft = first.querySelector("[data-testid=credits-offer-time-left]");
    if (timeLeft === null) throw new Error("no time-left trigger");
    expect(tooltipTextFor(timeLeft)).toBe(
      CREDITS_PAGE.offerEnds(
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(launch.endsAt)),
      ),
    );
    // A null description adds no line: the row is figures, name and time.
    expect(second.textContent).toBe("$4.00of $10.00Plain offer5 days left");
  });

  it("counts offers in credits, not dollars, in the installed app", () => {
    setMobileApp(true);
    mocks.data = userWithOffers([offer({})]);

    renderPanel();

    expect(screen.getByTestId("credits-offer-remaining").textContent).toBe(
      "12.50 credits",
    );
    expect(screen.getByTestId("credits-offer-grant").textContent).toBe(
      "of 25.00 credits",
    );
  });

  it("keeps offer credit out of the balance", () => {
    mocks.data = userWithOffers([offer({ remainingCredits: 12.5 })]);

    renderPanel();

    expect(screen.getByTestId("credits-remaining").textContent).toBe(
      "$70.00 left",
    );
    expect(screen.getByTestId("credits-offer-remaining").textContent).toBe(
      "$12.50",
    );
  });

  it("explains the terms from the About credit offers button", () => {
    mocks.data = userWithOffers([offer({})]);

    renderPanel();
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

describe("CreditsSettingsPanel claiming offers", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const GRANT = 25;

  function listed(overrides: Partial<CreditOffer>): CreditOffer {
    return {
      id: "c1",
      name: "Launch offer",
      description: null,
      grantCredits: GRANT,
      startsAt: new Date(Date.now() - DAY_MS).toISOString(),
      endsAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
      claim: "none",
      remainingCredits: null,
      ...overrides,
    };
  }

  function claimed(offer: CreditOffer): CreditOffer {
    return { ...offer, claim: "active", remainingCredits: offer.grantCredits };
  }

  function userRecord(
    campaignCredits: AuthenticatedUserCampaignCredit[],
    teams: TraycerTeamSubscription[],
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
        teams,
      ),
      campaignCredits,
    };
  }

  function rowNamed(name: string): HTMLElement {
    const row = screen
      .getAllByTestId("credits-offer-row")
      .find((candidate) => within(candidate).queryByText(name) !== null);
    if (row === undefined) {
      throw new Error(`No offer row named ${name}`);
    }
    return row;
  }

  beforeEach(() => {
    mocks.data = userRecord([], []);
    mocks.isPending = false;
    mocks.isError = false;
    mocks.isFetching = false;
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("offers Claim on an unclaimed offer, a disabled Sold out on a full one, and hides a revoked or ended one", async () => {
    mocks.auth.listCreditOffers.mockResolvedValue({
      kind: "ok",
      offers: [
        listed({ id: "open", name: "Open offer" }),
        listed({ id: "full", name: "Full offer", claim: "sold_out" }),
        listed({ id: "gone", name: "Revoked offer", claim: "revoked" }),
        listed({
          id: "old",
          name: "Ended offer",
          endsAt: new Date(Date.now() - 60 * 1000).toISOString(),
        }),
      ],
    });

    renderPanel();

    await screen.findByText("Open offer");
    expect(
      within(rowNamed("Open offer")).getByRole("button", {
        name: CREDITS_PAGE.offerClaim,
      }),
    ).toHaveProperty("disabled", false);
    expect(
      within(rowNamed("Full offer")).getByRole("button", {
        name: CREDITS_PAGE.offerSoldOut,
      }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText("Revoked offer")).toBeNull();
    expect(screen.queryByText("Ended offer")).toBeNull();
  });

  it("lists an offer the user record already carries once", async () => {
    mocks.data = userRecord(
      [
        {
          campaignId: "c1",
          name: "Launch offer",
          description: null,
          grantCredits: GRANT,
          remainingCredits: 12.5,
          endsAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
        },
      ],
      [],
    );
    mocks.auth.listCreditOffers.mockResolvedValue({
      kind: "ok",
      offers: [
        listed({ id: "c1", name: "Launch offer" }),
        listed({ id: "c2", name: "Second offer" }),
      ],
    });

    renderPanel();

    // The second offer only appears once the list has landed.
    await screen.findByText("Second offer");
    expect(screen.getAllByText("Launch offer")).toHaveLength(1);
    expect(screen.getAllByTestId("credits-offer-row")).toHaveLength(2);
  });

  it("claims an offer: the button waits while pending, then the row reads as claimed and the list is refetched", async () => {
    const offer = listed({});
    let current = offer;
    let finishClaim: (result: ClaimCreditOfferFetchResult) => void = () => {};
    mocks.auth.listCreditOffers.mockImplementation(() =>
      Promise.resolve({ kind: "ok", offers: [current] }),
    );
    mocks.auth.claimCreditOffer.mockImplementation(
      () =>
        new Promise<ClaimCreditOfferFetchResult>((resolve) => {
          finishClaim = resolve;
        }),
    );

    renderPanel();
    const claimButton = await screen.findByRole("button", {
      name: CREDITS_PAGE.offerClaim,
    });
    expect(mocks.auth.listCreditOffers).toHaveBeenCalledTimes(1);
    fireEvent.click(claimButton);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: CREDITS_PAGE.offerClaim }),
      ).toHaveProperty("disabled", true);
    });
    expect(mocks.auth.claimCreditOffer).toHaveBeenCalledWith("c1");

    current = claimed(offer);
    finishClaim({ kind: "ok", offer: current });

    expect(await screen.findByTestId("credits-offer-grant")).toHaveProperty(
      "textContent",
      CREDITS_PAGE.offerGrant("$25.00"),
    );
    expect(
      screen.queryByRole("button", { name: CREDITS_PAGE.offerClaim }),
    ).toBeNull();
    await waitFor(() => {
      expect(mocks.auth.listCreditOffers).toHaveBeenCalledTimes(2);
    });
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("treats an already-claimed answer as no failure and refetches the list", async () => {
    mocks.auth.listCreditOffers.mockResolvedValue({
      kind: "ok",
      offers: [listed({})],
    });
    mocks.auth.claimCreditOffer.mockResolvedValue({ kind: "conflict" });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: CREDITS_PAGE.offerClaim }),
    );

    await waitFor(() => {
      expect(mocks.auth.listCreditOffers).toHaveBeenCalledTimes(2);
    });
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("toasts why an unavailable offer cannot be claimed", async () => {
    mocks.auth.listCreditOffers.mockResolvedValue({
      kind: "ok",
      offers: [listed({})],
    });
    mocks.auth.claimCreditOffer.mockResolvedValue({
      kind: "unavailable",
      reason: "sold-out",
    });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: CREDITS_PAGE.offerClaim }),
    );

    await waitFor(() => {
      expect(mocks.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    const [error, fallback] = mocks.toastFromAuthError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : null).toBe(
      CREDITS_PAGE.claimSoldOut,
    );
    expect(fallback).toBe(CREDITS_PAGE.claimFailed);
  });
});
