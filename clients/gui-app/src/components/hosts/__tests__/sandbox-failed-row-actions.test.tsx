import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { useSandboxFailedRowRetryStore } from "@/stores/sandboxes/sandbox-failed-row-retry-store";
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
const environmentListRequests: number[] = [];
const FAILED_SANDBOX_ID = "failed-team-sandbox";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

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

async function retryAndExpectToast(options: {
  readonly configuration: SandboxPageConfiguration;
  readonly environmentRole: "admin" | "editor" | "viewer";
  readonly refusal: SandboxCreateFetchResult;
  readonly expected: string | null;
  readonly retryAgain: boolean;
}): Promise<ReadonlyArray<string | null>> {
  const {
    configuration,
    environmentRole,
    refusal,
    expected,
    retryAgain,
  } = options;
  const binding = createFakeSandboxBinding();
  const queryClient = createQueryClient();
  signInAs("viewer");
  const view = renderFailedRow(binding, configuration, environmentRole, queryClient);
  binding.auth.createSandbox.mockResolvedValue(refusal);
  if (configuration.kind === "team") {
    await waitFor(() => {
      expect(environmentListRequests.length).toBeGreaterThan(0);
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

  await waitFor(() =>
    expected === null
      ? expect(mocks.toastError).toHaveBeenCalledTimes(1)
      : expect(mocks.toastError).toHaveBeenCalledWith(expected),
  );
  expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
  if (retryAgain) {
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2));
  }
  view.unmount();
  return binding.auth.createSandbox.mock.calls.map(
    ([request]) => request.clientRequestId,
  );
}

function signInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: "Viewer", email: "viewer@example.test" },
    contextMetadata: { userId, username: "viewer" },
  });
}

function renderFailedRow(
  binding: FakeSandboxBinding,
  configuration: SandboxPageConfiguration,
  environmentRole: "admin" | "editor" | "viewer",
  queryClient: QueryClient,
) {
  mocks.binding = binding;
  if (configuration.kind === "team") {
    binding.auth.getTeamEnvironment.mockResolvedValue({
      kind: "ok",
      environmentId: configuration.environmentId ?? "env-acme",
    });
  }
  return render(
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
      onEnvironmentListRead={() => {
        environmentListRequests.push(1);
      }}
    >
      <SandboxFailedRowActions
        summary={sandboxSummaryFixture({
          id: FAILED_SANDBOX_ID,
          state: "failed",
          environmentId: "env-acme",
        })}
        configuration={configuration}
        credits={configuration}
      />
    </SandboxBillingRuntime>,
  );
}

afterEach(() => {
  cleanup();
  mocks.binding = null;
  environmentListRequests.length = 0;
  mocks.toastError.mockReset();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useSandboxFailedRowRetryStore.setState({ byAccountAndRow: {} });
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
      await retryAndExpectToast({
        configuration,
        environmentRole,
        refusal,
        expected,
        retryAgain: false,
      });
    },
  );

  it.each([
    ["401", { kind: "unauthorized" }, true],
    ["untyped 403", { kind: "unauthorized" }, true],
    ["402", refusedCreate(), false],
  ] as const)("uses the correct request key after a %s", async (_status, answer, keepsKey) => {
    const keys = await retryAndExpectToast({
      configuration: PERSONAL_CONFIGURATION,
      environmentRole: "editor",
      refusal: answer,
      expected: null,
      retryAgain: true,
    });

    expect(keys[1] === keys[0]).toBe(keepsKey);
  });

  it("reuses an unauthorized Retry key after the failed row remounts", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox.mockResolvedValue({ kind: "unauthorized" });
    const firstView = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    const firstKey = binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    firstView.unmount();

    renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const remountedRetry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(remountedRetry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );

    expect(binding.auth.createSandbox.mock.calls[1]?.[0].clientRequestId).toBe(
      firstKey,
    );
  });

  it("keeps unresolved Retry keys separate by account for the same row", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox.mockResolvedValue({
      kind: "network-error",
      detail: "offline",
    });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    let retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    const accountAKey = binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty(
        "disabled",
        false,
      ),
    );

    retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-b");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
    const accountBKey = binding.auth.createSandbox.mock.calls[1]?.[0].clientRequestId;
    expect(accountBKey).not.toBe(accountAKey);

    retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(3),
    );
    expect(binding.auth.createSandbox.mock.calls[2]?.[0].clientRequestId).toBe(
      accountAKey,
    );
    view.unmount();
  });

  it("clears a successful Retry after unmount so a remounted row starts fresh", async () => {
    const binding = createFakeSandboxBinding();
    const createAnswer: {
      resolve: ((result: SandboxCreateFetchResult) => void) | null;
    } = { resolve: null };
    binding.auth.createSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          createAnswer.resolve = resolve;
        }),
    );
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    const firstKey = binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
    await waitFor(() =>
      expect(
        useSandboxFailedRowRetryStore.getState().byAccountAndRow[
          `account-a:${FAILED_SANDBOX_ID}`
        ],
      ).toBe(firstKey),
    );
    view.unmount();

    const answer = createAnswer.resolve;
    if (answer === null) throw new Error("the create promise was not captured");
    act(() => {
      answer({
        kind: "ok",
        accepted: {
          sandboxId: "created-sandbox",
          hostId: "created-host",
          sandbox: sandboxSummaryFixture({
            id: "created-sandbox",
            hostId: "created-host",
            state: "creating",
          }),
        },
      });
    });
    await waitFor(() =>
      expect(
        useSandboxFailedRowRetryStore.getState().byAccountAndRow[
          `account-a:${FAILED_SANDBOX_ID}`
        ],
      ).toBeUndefined(),
    );

    binding.auth.createSandbox.mockResolvedValue({ kind: "unauthorized" });
    renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const remountedRetry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await userEvent.click(remountedRetry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );

    expect(binding.auth.createSandbox.mock.calls[1]?.[0].clientRequestId).not.toBe(
      firstKey,
    );
  });
});
