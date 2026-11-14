import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { SandboxFailedRowActions } from "@/components/hosts/sandbox-failed-row-actions";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  buysTeamCredits: false,
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-team-billing-admin", () => ({
  useOffersAddCredits: () => mocks.buysTeamCredits,
}));

const TEAM_CONFIGURATION: SandboxPageConfiguration = {
  kind: "team",
  teamId: "team-acme",
  teamName: "Acme",
  environmentId: "env-acme",
};

const PERSONAL_CONFIGURATION: SandboxPageConfiguration = { kind: "personal" };

function refusedCreate(): SandboxCreateFetchResult {
  return {
    kind: "refused",
    status: 402,
    code: "insufficient_credit",
    reason: "denied",
    shortfallMc: 120,
    newRateMcPerHour: 120,
    currentAwakeBurnMcPerHour: 0,
    message: null,
    creditSource: "team",
  };
}

async function retryAndExpectToast(
  configuration: SandboxPageConfiguration,
  buysTeamCredits: boolean,
  refusal: SandboxCreateFetchResult,
  expected: string,
): Promise<void> {
  const binding = createFakeSandboxBinding();
  mocks.binding = binding;
  mocks.buysTeamCredits = buysTeamCredits;
  binding.auth.createSandbox.mockResolvedValue(refusal);
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "viewer",
      userName: "Viewer",
      email: "viewer@example.test",
    },
    contextMetadata: { userId: "viewer", username: "viewer" },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SandboxFailedRowActions
        summary={sandboxSummaryFixture({
          id: "failed-team-sandbox",
          state: "failed",
          environmentId: "env-acme",
        })}
        configuration={configuration}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expected));
  expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
}

afterEach(() => {
  cleanup();
  mocks.binding = null;
  mocks.buysTeamCredits = false;
  mocks.toastError.mockReset();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("SandboxFailedRowActions Retry", () => {
  it.each([
    {
      reader: "Editor",
      configuration: TEAM_CONFIGURATION,
      buysTeamCredits: false,
      refusal: refusedCreate(),
      expected: "The team's credits don't cover an hour of this sandbox.",
    },
    {
      reader: "Admin",
      configuration: TEAM_CONFIGURATION,
      buysTeamCredits: true,
      refusal: refusedCreate(),
      expected:
        "The team's credits don't cover an hour of this sandbox. Add $1.20 and try again.",
    },
    {
      reader: "Personal reader",
      configuration: PERSONAL_CONFIGURATION,
      buysTeamCredits: false,
      refusal: { ...refusedCreate(), creditSource: "personal" },
      expected:
        "Your credits don't cover an hour of this sandbox. Add $1.20 and try again.",
    },
    {
      reader: "team reader with an unverified balance",
      configuration: TEAM_CONFIGURATION,
      buysTeamCredits: false,
      refusal: { ...refusedCreate(), reason: "unverified" },
      expected:
        "Traycer couldn't confirm your credit balance. Try again in a moment.",
    },
  ])(
    "shows the right create refusal to a $reader after Retry",
    async ({ configuration, buysTeamCredits, refusal, expected }) => {
      await retryAndExpectToast(
        configuration,
        buysTeamCredits,
        refusal,
        expected,
      );
    },
  );
});
