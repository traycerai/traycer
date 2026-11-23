import { QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SandboxFailedChatActions,
  SandboxFailedRowActions,
} from "@/components/hosts/sandbox-failed-row-actions";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
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
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-configurations")
      >();
    const team = {
      kind: "team" as const,
      teamId: "team-acme",
      teamName: "Acme",
      environmentId: "env-acme",
    };
    return {
      ...actual,
      useSandboxConfigurations: () => ({
        configurations: [team],
        teamEnvironmentIds: new Set([team.environmentId]),
        complete: true,
        personalEnvironmentId: null,
      }),
      sandboxConfigurationOf: () => team,
    };
  },
);
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
  const { configuration, environmentRole, refusal, expected, retryAgain } =
    options;
  const binding = createFakeSandboxBinding();
  const queryClient = createQueryClient();
  signInAs("viewer");
  const view = renderFailedRow(
    binding,
    configuration,
    environmentRole,
    queryClient,
  );
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
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
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
  return renderFailedRows({
    binding,
    configuration,
    environmentRole,
    queryClient,
    rows: [{ key: "failed-row", summary: failedRowSummary() }],
  });
}

function renderFailedChatActions(
  binding: FakeSandboxBinding,
  queryClient: QueryClient,
) {
  mocks.binding = binding;
  binding.auth.getTeamEnvironment.mockResolvedValue({
    kind: "ok",
    environmentId: "env-acme",
  });
  return render(
    <SandboxBillingRuntime
      answer={{ kind: "ready", role: "editor" }}
      hostId="billing-host"
      environmentId="env-acme"
      queryClient={queryClient}
      onBinding={(runtimeBinding: HostRuntimeBinding<HostRpcRegistry>) => {
        vi.spyOn(runtimeBinding.auth, "getTeamEnvironment").mockImplementation(
          (teamId) => binding.auth.getTeamEnvironment(teamId),
        );
        vi.spyOn(runtimeBinding.auth, "createSandbox").mockImplementation(
          (request) => binding.auth.createSandbox(request),
        );
      }}
      onEnvironmentListRead={() => {
        environmentListRequests.push(1);
      }}
    >
      <SandboxFailedChatActions summary={failedRowSummary()} />
    </SandboxBillingRuntime>,
  );
}

function renderFailedRows({
  binding,
  configuration,
  environmentRole,
  queryClient,
  rows,
}: {
  binding: FakeSandboxBinding;
  configuration: SandboxPageConfiguration;
  environmentRole: "admin" | "editor" | "viewer";
  queryClient: QueryClient;
  rows: readonly { key: string; summary: SandboxSummary }[];
}) {
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
      {rows.map(({ key, summary }) => (
        <SandboxFailedRowActions
          key={key}
          summary={summary}
          configuration={configuration}
          credits={configuration}
        />
      ))}
    </SandboxBillingRuntime>,
  );
}

function failedRowSummary(): SandboxSummary {
  return sandboxSummaryFixture({
    id: FAILED_SANDBOX_ID,
    state: "failed",
    environmentId: "env-acme",
  });
}

function walkAnswer(
  step: number,
  replayState: "awake" | "failed" | null,
): SandboxCreateFetchResult {
  if (step < 5) {
    const id = `holder-${step + 1}`;
    return {
      kind: "ok",
      joined: true,
      accepted: {
        sandboxId: id,
        hostId: `host-${id}`,
        sandbox: sandboxSummaryFixture({ id, state: "destroyed" }),
      },
    };
  }
  const id = "final-holder";
  return {
    kind: "ok",
    ...(replayState === null ? {} : { joined: true }),
    accepted: {
      sandboxId: id,
      hostId: `host-${id}`,
      sandbox: sandboxSummaryFixture({
        id,
        state: replayState ?? "awake",
      }),
    },
  };
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
    ["402", refusedCreate(), true],
  ] as const)(
    "uses the correct request key after a %s",
    async (_status, answer, keepsKey) => {
      const keys = await retryAndExpectToast({
        configuration: PERSONAL_CONFIGURATION,
        environmentRole: "editor",
        refusal: answer,
        expected: null,
        retryAgain: true,
      });

      expect(keys[1] === keys[0]).toBe(keepsKey);
    },
  );

  it.each([
    ["402", refusedCreate(), true],
    ["unauthorized", { kind: "unauthorized" }, true],
  ] as const)(
    "serializes simultaneous Retry controls after a %s answer",
    async (_name, firstAnswer, keepsKey) => {
      const answer = Promise.withResolvers<SandboxCreateFetchResult>();
      const binding = createFakeSandboxBinding();
      binding.auth.createSandbox.mockImplementationOnce(() => answer.promise);
      binding.auth.createSandbox.mockResolvedValue({ kind: "unauthorized" });
      const summary = failedRowSummary();
      renderFailedRows({
        binding,
        configuration: PERSONAL_CONFIGURATION,
        environmentRole: "editor",
        queryClient: createQueryClient(),
        rows: [
          { key: "first-control", summary },
          { key: "second-control", summary },
        ],
      });
      await waitFor(() =>
        expect(screen.getAllByTestId("sandbox-row-retry")).toHaveLength(2),
      );
      const [firstButton, secondButton] =
        screen.getAllByTestId("sandbox-row-retry");
      act(() => signInAs("account-a"));

      act(() => {
        fireEvent.click(firstButton);
        fireEvent.click(secondButton);
      });
      await waitFor(() =>
        expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
      );
      const firstKey =
        binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
      expect(firstButton).toHaveProperty("disabled", true);
      expect(secondButton).toHaveProperty("disabled", true);
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);

      act(() => answer.resolve(firstAnswer));
      await waitFor(() => {
        expect(firstButton).toHaveProperty("disabled", false);
        expect(secondButton).toHaveProperty("disabled", false);
      });
      await userEvent.click(secondButton);
      await waitFor(() =>
        expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
      );

      const secondKey =
        binding.auth.createSandbox.mock.calls[1]?.[0].clientRequestId;
      expect(secondKey === firstKey).toBe(keepsKey);
    },
  );

  it("reuses the derived Retry key after the failed row remounts", async () => {
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
    const firstKey =
      binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
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

  it("uses the same derived Retry key in a second window for the same account", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox.mockResolvedValue({
      kind: "unauthorized",
    });
    const firstView = renderFailedRow(
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
    const accountAKey =
      binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty(
        "disabled",
        false,
      ),
    );

    const secondWindow = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    retry = await within(secondWindow.container).findByRole("button", {
      name: "Retry",
    });
    signInAs("account-a");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
    expect(binding.auth.createSandbox.mock.calls[1]?.[0].clientRequestId).toBe(
      accountAKey,
    );
    expect(accountAKey).toBe(`retry:${FAILED_SANDBOX_ID}`);
    if (accountAKey === null) throw new Error("expected a create key");
    expect(accountAKey.length).toBeGreaterThanOrEqual(1);
    expect(accountAKey.length).toBeLessThanOrEqual(64);
    firstView.unmount();
    secondWindow.unmount();
  });

  it("keeps the 502 row's Retry key after the next press receives a 402", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        ...refusedCreate(),
        status: 502,
        code: "provider_failed",
        sandboxId: "sandbox-from-502",
      })
      .mockResolvedValueOnce(refusedCreate())
      .mockResolvedValue({ kind: "unauthorized" });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");

    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(3),
    );

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([
      `retry:${FAILED_SANDBOX_ID}`,
      "retry:sandbox-from-502",
      "retry:sandbox-from-502",
    ]);
    view.unmount();
  });

  it("lets a second window reach the same refused Retry key while the first press is pending", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    const firstAnswer = Promise.withResolvers<SandboxCreateFetchResult>();
    const keys: Array<string | null> = [];
    const reservedKeys = new Set<string>();
    let newReservations = 0;
    binding.auth.createSandbox.mockImplementation((request) => {
      const key = request.clientRequestId;
      if (key === null) throw new Error("Retry did not send a key");
      keys.push(key);
      if (!reservedKeys.has(key)) {
        reservedKeys.add(key);
        newReservations += 1;
      }
      return keys.length === 1
        ? firstAnswer.promise
        : Promise.resolve(refusedCreate());
    });

    const firstWindow = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const firstRetry = await within(firstWindow.container).findByRole(
      "button",
      {
        name: "Retry",
      },
    );
    const secondWindow = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const secondRetry = await within(secondWindow.container).findByRole(
      "button",
      { name: "Retry" },
    );
    signInAs("account-a");
    await user.click(firstRetry);
    await waitFor(() => expect(keys).toHaveLength(1));
    await user.click(secondRetry);
    await waitFor(() => expect(keys).toHaveLength(2));
    act(() => firstAnswer.resolve(refusedCreate()));
    await waitFor(() => {
      expect(firstRetry).toHaveProperty("disabled", false);
      expect(secondRetry).toHaveProperty("disabled", false);
    });
    await user.click(firstRetry);
    await waitFor(() => expect(keys).toHaveLength(3));
    await waitFor(() => expect(firstRetry).toHaveProperty("disabled", false));
    await user.click(secondRetry);
    await waitFor(() => expect(keys).toHaveLength(4));
    await waitFor(() => expect(secondRetry).toHaveProperty("disabled", false));

    expect(keys).toEqual([
      `retry:${FAILED_SANDBOX_ID}`,
      `retry:${FAILED_SANDBOX_ID}`,
      `retry:${FAILED_SANDBOX_ID}`,
      `retry:${FAILED_SANDBOX_ID}`,
    ]);
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(4);
    expect(newReservations).toBe(1);
    firstWindow.unmount();
    secondWindow.unmount();
  });

  it("stops at a joined destroyed credit-gate row before the next Retry", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: "credit-gate-row",
          hostId: "host-credit-gate-row",
          sandbox: sandboxSummaryFixture({
            id: "credit-gate-row",
            state: "destroyed",
            failureCode: "credit-gate",
          }),
        },
      })
      .mockResolvedValueOnce({ kind: "unauthorized" });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([`retry:${FAILED_SANDBOX_ID}`, "retry:credit-gate-row"]);
    view.unmount();
  });

  it("does not walk past a newly created destroyed row that was not joined", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        accepted: {
          sandboxId: "new-destroyed-row",
          hostId: "host-new-destroyed-row",
          sandbox: sandboxSummaryFixture({
            id: "new-destroyed-row",
            state: "destroyed",
          }),
        },
      })
      .mockResolvedValueOnce({ kind: "unauthorized" });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([`retry:${FAILED_SANDBOX_ID}`, "retry:new-destroyed-row"]);
    view.unmount();
  });

  it("re-walks from the key chosen for the press after a no-row 503 interrupts the walk", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    const joinedDestroyed: SandboxCreateFetchResult = {
      kind: "ok",
      joined: true,
      accepted: {
        sandboxId: "holder-after-interruption",
        hostId: "host-holder-after-interruption",
        sandbox: sandboxSummaryFixture({
          id: "holder-after-interruption",
          state: "destroyed",
        }),
      },
    };
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        ...refusedCreate(),
        status: 502,
        code: "provider_failed",
        sandboxId: "shown-failure",
      })
      .mockResolvedValueOnce(joinedDestroyed)
      .mockResolvedValueOnce({
        kind: "refused",
        status: 503,
        code: "provider_unavailable",
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: null,
      })
      .mockResolvedValueOnce(joinedDestroyed)
      .mockResolvedValueOnce({
        kind: "ok",
        accepted: {
          sandboxId: "created-after-interruption",
          hostId: "host-created-after-interruption",
          sandbox: sandboxSummaryFixture({
            id: "created-after-interruption",
            state: "awake",
          }),
        },
      });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("account-a");
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(3),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    expect(mocks.toastError).toHaveBeenNthCalledWith(
      2,
      "Sandboxes aren't available right now. Try again later.",
    );
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(5),
    );

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([
      `retry:${FAILED_SANDBOX_ID}`,
      "retry:shown-failure",
      "retry:holder-after-interruption",
      "retry:shown-failure",
      "retry:holder-after-interruption",
    ]);
    view.unmount();
  });

  it("stops when a destroyed joined row would repeat the key already walked", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: FAILED_SANDBOX_ID,
          hostId: "host-repeated-key",
          sandbox: sandboxSummaryFixture({
            id: FAILED_SANDBOX_ID,
            state: "destroyed",
          }),
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: FAILED_SANDBOX_ID,
          hostId: "host-repeated-key",
          sandbox: sandboxSummaryFixture({
            id: FAILED_SANDBOX_ID,
            state: "awake",
          }),
        },
      });
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
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("uses the failed chat row's shown 502 id for its next Retry", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        ...refusedCreate(),
        status: 502,
        code: "provider_failed",
        sandboxId: "sandbox-from-502",
      })
      .mockResolvedValueOnce({ kind: "unauthorized" });
    const view = renderFailedChatActions(binding, createQueryClient());
    const retry = await within(view.container).findByRole("button", {
      name: "Retry",
    });
    signInAs("account-a");
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([`retry:${FAILED_SANDBOX_ID}`, "retry:sandbox-from-502"]);
    view.unmount();
  });

  it.each([
    ["live", "awake"],
    ["failed", "failed"],
  ] as const)(
    "walks five joined destroyed holders once, then stops when the second window sees the final holder %s",
    async (_arrival, replayState) => {
      const user = userEvent.setup();
      const binding = createFakeSandboxBinding();
      const keys: Array<string | null> = [];
      const answers: Array<(result: SandboxCreateFetchResult) => void> = [];
      const walkedAnswers: SandboxCreateFetchResult[] = [];
      binding.auth.createSandbox.mockImplementation((request) => {
        keys.push(request.clientRequestId);
        const answer = Promise.withResolvers<SandboxCreateFetchResult>();
        answers.push(answer.resolve);
        return answer.promise;
      });

      const runWindow = async (
        offset: number,
        button: HTMLElement,
        state: "awake" | "failed" | null,
      ): Promise<void> => {
        await user.click(button);
        for (let step = 0; step < 6; step += 1) {
          const index = offset + step;
          await waitFor(() => expect(keys).toHaveLength(index + 1));
          expect(button).toHaveProperty("disabled", true);
          act(() => {
            const answer = walkAnswer(step, state);
            walkedAnswers.push(answer);
            answers[index]?.(answer);
          });
        }
        await waitFor(() => expect(button).toHaveProperty("disabled", false));
      };

      const firstWindow = renderFailedRow(
        binding,
        PERSONAL_CONFIGURATION,
        "editor",
        createQueryClient(),
      );
      let button = await screen.findByRole("button", { name: "Retry" });
      signInAs("account-a");
      await runWindow(0, button, null);
      firstWindow.unmount();

      const secondWindow = renderFailedRow(
        binding,
        PERSONAL_CONFIGURATION,
        "editor",
        createQueryClient(),
      );
      button = await within(secondWindow.container).findByRole("button", {
        name: "Retry",
      });
      signInAs("account-a");
      await runWindow(6, button, replayState);

      const oneWalk = [
        `retry:${FAILED_SANDBOX_ID}`,
        "retry:holder-1",
        "retry:holder-2",
        "retry:holder-3",
        "retry:holder-4",
        "retry:holder-5",
      ];
      expect(keys).toEqual([...oneWalk, ...oneWalk]);
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(12);
      expect(
        walkedAnswers.map(
          (answer) => answer.kind === "ok" && answer.joined === true,
        ),
      ).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(keys[0]?.length).toBeGreaterThanOrEqual(1);
      expect(keys[0]?.length).toBeLessThanOrEqual(64);
      firstWindow.unmount();
      secondWindow.unmount();
    },
  );
});
