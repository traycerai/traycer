import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { useAuthStore } from "@/stores/auth/auth-store";

// The read goes through the real query and the real auth-user hook; only the
// service that fetches the user is faked.
const auth = vi.hoisted(() => ({
  fetchAuthenticatedUser: vi.fn<() => Promise<AuthenticatedUser | null>>(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => auth,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
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

beforeEach(() => {
  auth.fetchAuthenticatedUser.mockReset();
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("CreditsSettingsPanel read failure", () => {
  it("reads the user again on Retry and shows the balance once it answers", async () => {
    auth.fetchAuthenticatedUser
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(
        userWith(
          userSubscription({
            totalPlanCredits: 100,
            consumedFromPlan: 30,
            bonusCredits: 0,
            consumedFromBonus: 0,
            bundleRemaining: 0,
          }),
          [],
        ),
      );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CreditsSettingsPanel />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(/Couldn't read your credits\./),
    ).toBeTruthy();
    expect(auth.fetchAuthenticatedUser).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByTestId("credits-remaining").textContent).toBe(
        "$70.00 left",
      );
    });
    expect(auth.fetchAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});
