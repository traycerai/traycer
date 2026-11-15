import { QueryClient } from "@tanstack/react-query";
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
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));
const TEAM_CONFIGURATION: SandboxPageConfiguration = {
  kind: "team",
  teamId: "team-acme",
  teamName: "Acme",
  environmentId: "env-acme",
};

const PERSONAL_CONFIGURATION: SandboxPageConfiguration = { kind: "personal" };
const environmentListRequests: Array<string | null> = [];

function refusedCreate(): Extract<
  SandboxCreateFetchResult,
  { readonly kind: "refused" }
> {
  return {
    kind: "refused",
    status: 402,
    code: "insufficient_credit",
    reason: "denied",
    shortfallMc: 1_200,
    newRateMcPerHour: 1_200,
    currentAwakeBurnMcPerHour: 0,
    message: null,
    creditSource: "team",
  };
}

interface RetryRefusalCase {
  readonly reader: string;
  readonly configuration: SandboxPageConfiguration;
  readonly environmentRole: "admin" | "editor" | "viewer";
  readonly refusal: SandboxCreateFetchResult;
  readonly expected: string;
}

async function retryAndExpectToast(
  configuration: SandboxPageConfiguration,
  environmentRole: "admin" | "editor" | "viewer",
  refusal: SandboxCreateFetchResult,
  expected: string,
): Promise<void> {
  const binding = createFakeSandboxBinding();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.binding = binding;
  if (configuration.kind === "team") {
    binding.auth.getTeamEnvironment.mockResolvedValue({
      kind: "ok",
      environmentId: configuration.environmentId ?? "env-acme",
    });
  }
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
  render(
    <SandboxBillingRuntime
      answer={{ kind: "ready", role: environmentRole }}
      hostId="billing-host"
      environmentId={
        configuration.kind === "team"
          ? (configuration.environmentId ?? "env-acme")
          : "env-acme"
      }
      queryClient={queryClient}
      onBinding={(runtimeBinding: HostRuntimeBinding<HostRpcRegistry>) => {
        const fakeBinding = mocks.binding;
        if (fakeBinding === null) {
          throw new Error("the fake AuthService answers were not prepared");
        }
        vi.spyOn(runtimeBinding.auth, "getTeamEnvironment").mockImplementation(
          (teamId) => fakeBinding.auth.getTeamEnvironment(teamId),
        );
        vi.spyOn(runtimeBinding.auth, "createSandbox").mockImplementation(
          (request) => fakeBinding.auth.createSandbox(request),
        );
      }}
      onEnvironmentListRequest={(hostId) => {
        environmentListRequests.push(hostId);
      }}
    >
      <SandboxFailedRowActions
        summary={sandboxSummaryFixture({
          id: "failed-team-sandbox",
          state: "failed",
          environmentId: "env-acme",
        })}
        configuration={configuration}
        credits={configuration}
      />
    </SandboxBillingRuntime>,
  );
  if (configuration.kind === "team") {
    await waitFor(() => {
      expect(environmentListRequests).toContain("billing-host");
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              query.queryKey.includes("environment.list") &&
              query.state.status === "success",
          ),
      ).toBe(true);
    });
  }
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expected));
  expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
}

afterEach(() => {
  cleanup();
  mocks.binding = null;
  environmentListRequests.length = 0;
  mocks.toastError.mockReset();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

const RETRY_REFUSAL_CASES: readonly RetryRefusalCase[] = [
  {
    reader: "Editor",
    configuration: TEAM_CONFIGURATION,
    environmentRole: "editor",
    refusal: refusedCreate(),
    expected: "The team's credits don't cover an hour of this sandbox.",
  },
  {
    reader: "Admin",
    configuration: TEAM_CONFIGURATION,
    environmentRole: "admin",
    refusal: refusedCreate(),
    expected:
      "The team's credits don't cover an hour of this sandbox. Add $1.20 and try again.",
  },
  {
    reader: "Personal reader",
    configuration: PERSONAL_CONFIGURATION,
    environmentRole: "editor",
    refusal: { ...refusedCreate(), creditSource: "personal" },
    expected:
      "Your credits don't cover an hour of this sandbox. Add $1.20 and try again.",
  },
  {
    reader: "team reader with an unverified balance",
    configuration: TEAM_CONFIGURATION,
    environmentRole: "editor",
    refusal: { ...refusedCreate(), reason: "unverified" },
    expected:
      "Traycer couldn't confirm your credit balance. Try again in a moment.",
  },
];

describe("SandboxFailedRowActions Retry", () => {
  it.each(RETRY_REFUSAL_CASES)(
    "shows the right create refusal to a $reader after Retry",
    async ({ configuration, environmentRole, refusal, expected }) => {
      await retryAndExpectToast(
        configuration,
        environmentRole,
        refusal,
        expected,
      );
    },
  );
});
