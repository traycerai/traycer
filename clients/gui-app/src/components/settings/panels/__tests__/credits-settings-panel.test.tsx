import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { setMobileApp } from "@/lib/mobile-app";
import type { StagedNewShape } from "@/lib/sandboxes/staged-sandbox-in-window";

/** A landing composer's staged New sandbox, as the panel reads it. */
interface StagedNewFixture {
  readonly target: { readonly kind: "new"; readonly shape: StagedNewShape };
}

const mocks = vi.hoisted(() => ({
  data: null as AuthenticatedUser | null,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(() => Promise.resolve({})),
  openLink: vi.fn(() => Promise.resolve()),
  staged: null as StagedNewFixture | null,
  catalogue: null as SandboxCatalogue | null,
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

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));

vi.mock("@/lib/sandboxes/staged-sandbox-in-window", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/sandboxes/staged-sandbox-in-window")
    >();
  return {
    ...actual,
    useStagedSandboxInThisWindow: () => mocks.staged,
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://traycer.ai/sign-in" }),
}));

import { CreditsSettingsPanel } from "../credits-settings-panel";

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 8,
        cpuStep: 1,
        memoryMinMb: 2048,
        memoryMaxMb: 16384,
        memoryStepMb: 1024,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

// Rates chosen so each rung prices differently from the others and from the
// region's `fromPriceMcPerHour` (120): 1/1/10 -> 20, 2/4/20 -> 46, 4/8/40 -> 92.
const LISTED_SHAPES_CATALOGUE: SandboxCatalogue = {
  providers: CATALOGUE.providers.map((provider) => ({
    ...provider,
    shapes: [
      { cpus: 1, memoryMb: 1024, diskMb: 10240, default: false },
      { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true },
      { cpus: 4, memoryMb: 8192, diskMb: 40960, default: false },
      { cpus: 8, memoryMb: 16384, diskMb: 61440, default: false },
    ],
    regions: provider.regions.map((region) => ({
      ...region,
      pricing: {
        vcpuHourMillicredits: 7,
        memoryGbHourMillicredits: 3,
        diskGbHourMillicredits: 1,
        multiplier: 1,
      },
    })),
  })),
};

describe("CreditsSettingsPanel", () => {
  beforeEach(() => {
    mocks.data = null;
    mocks.isPending = false;
    mocks.isError = false;
    mocks.isFetching = false;
    mocks.staged = null;
    mocks.catalogue = CATALOGUE;
    mocks.openLink.mockClear();
    mocks.refetch.mockClear();
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("shows $0.00 left, the hourly line and Add credits at a zero balance, with the subtitle once", () => {
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

    expect(screen.getByTestId("credits-remaining").textContent).toBe(
      "$0.00 left",
    );
    expect(screen.getAllByText("Credits pay for your sandboxes.")).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: /Add credits/ })).toBeTruthy();
    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.12 an hour while awake",
    );
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

    expect(screen.getByTestId("credits-ready")).toBeTruthy();
    expect(screen.getByTestId("credits-remaining").textContent).toBe(
      "$70.00 left",
    );
    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.12 an hour while awake",
    );
    expect(screen.getByRole("button", { name: /Add credits/ })).toBeTruthy();
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

  it("quotes the default listed shape when nothing is staged", () => {
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
    mocks.catalogue = LISTED_SHAPES_CATALOGUE;

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.05 an hour while awake",
    );
  });

  // The first creatable provider serves Windows only and lists no shapes; its
  // $0.50 floor must not stand in for the Linux default rung (46 mc, $0.05).
  it("quotes the default stage's provider, not the first priced one", () => {
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
    const [windowsOnly] = CATALOGUE.providers;
    const [linuxListed] = LISTED_SHAPES_CATALOGUE.providers;
    mocks.catalogue = {
      providers: [
        {
          ...windowsOnly,
          os: ["windows"],
          regions: windowsOnly.regions.map((region) => ({
            ...region,
            fromPriceMcPerHour: { awakeMc: 500, suspendedMc: 4, stoppedMc: 2 },
          })),
        },
        linuxListed,
      ],
    };

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.05 an hour while awake",
    );
  });

  it("quotes the staged listed shape", () => {
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
    mocks.catalogue = LISTED_SHAPES_CATALOGUE;
    mocks.staged = {
      target: {
        kind: "new",
        shape: {
          os: "linux",
          region: "us-east",
          cpus: 4,
          memoryMb: 8192,
          diskMb: 40960,
        },
      },
    };

    render(<CreditsSettingsPanel />);

    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.09 an hour while awake",
    );
  });
});
