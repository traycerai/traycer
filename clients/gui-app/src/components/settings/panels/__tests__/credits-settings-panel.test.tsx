import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
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
  staged: null as { readonly target: { readonly kind: string } } | null,
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
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
        },
      ],
    },
  ],
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

  it("renders the empty sentence and Add credits at a zero balance", () => {
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

    expect(screen.getByTestId("credits-empty")).toBeTruthy();
    expect(
      screen.getAllByText("Credits pay for sandboxes while they are awake.")
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Add credits/ })).toBeTruthy();
    expect(screen.getByTestId("credits-hourly-price").textContent).toBe(
      "$0.12 an hour while awake",
    );
    expect(screen.queryByTestId("credits-remaining")).toBeNull();
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
    expect(screen.getByTestId("credits-remaining").textContent).toBe("$70.00");
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
});
