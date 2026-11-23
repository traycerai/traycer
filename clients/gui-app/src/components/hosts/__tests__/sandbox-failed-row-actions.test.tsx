import { QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
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
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
} from "@traycer/protocol/host/sandbox-control";
import {
  SandboxFailedChatActions,
  SandboxFailedRowActions,
} from "@/components/hosts/sandbox-failed-row-actions";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { createSandboxRetryWalkFake } from "@/hooks/sandboxes/__tests__/sandbox-retry-walk-fake";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: mocks.toastSuccess,
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
  return renderFailedRowWithSummary({
    binding,
    configuration,
    environmentRole,
    queryClient,
    summary: failedRowSummary(),
  });
}

function renderFailedRowWithSummary(options: {
  readonly binding: FakeSandboxBinding;
  readonly configuration: SandboxPageConfiguration;
  readonly environmentRole: "admin" | "editor" | "viewer";
  readonly queryClient: QueryClient;
  readonly summary: SandboxSummary;
}) {
  return renderFailedRows({
    binding: options.binding,
    configuration: options.configuration,
    environmentRole: options.environmentRole,
    queryClient: options.queryClient,
    rows: [{ key: "failed-row", summary: options.summary }],
  });
}

function RefreshableFailedRowSummary(props: {
  readonly initial: SandboxSummary;
  readonly refreshed: SandboxSummary;
}): ReactNode {
  const [summary, setSummary] = useState(props.initial);
  return (
    <>
      <button type="button" onClick={() => setSummary(props.refreshed)}>
        Refresh row
      </button>
      <SandboxFailedRowActions
        summary={summary}
        configuration={PERSONAL_CONFIGURATION}
        credits={PERSONAL_CONFIGURATION}
      />
    </>
  );
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
  return failedRowSummaryWith({});
}

function failedRowSummaryWith(
  overrides: Partial<SandboxSummary>,
): SandboxSummary {
  return sandboxSummaryFixture({
    id: FAILED_SANDBOX_ID,
    state: "failed",
    environmentId: "env-acme",
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  mocks.binding = null;
  environmentListRequests.length = 0;
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
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
  it("shows the named credit-gate refusal from a joined HTTP 200 row", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox.mockResolvedValue({
      kind: "ok",
      joined: true,
      accepted: {
        sandboxId: "sbx_credit_gate",
        hostId: "host-credit-gate",
        sandbox: sandboxSummaryFixture({
          id: "sbx_credit_gate",
          state: "destroyed",
          failureCode: "credit-gate",
          displayName: "origin/main hook",
        }),
      },
    });
    const view = renderFailedRow(
      binding,
      PERSONAL_CONFIGURATION,
      "editor",
      createQueryClient(),
    );
    signInAs("account-a");

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't start origin/main hook",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    view.unmount();
  });

  it("shows the provider failure for a joined ordinary failed row, then derives the next Retry key", async () => {
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: "sbx_ordinary_failed",
          hostId: "host-ordinary-failed",
          sandbox: sandboxSummaryFixture({
            id: "sbx_ordinary_failed",
            state: "failed",
            failureCode: "PROVIDER_CREATE_FAILED",
            displayName: "origin/main hook",
          }),
        },
      })
      .mockResolvedValue({ kind: "unauthorized" });
    const view = renderFailedRowWithSummary({
      binding,
      configuration: PERSONAL_CONFIGURATION,
      environmentRole: "editor",
      queryClient: createQueryClient(),
      summary: failedRowSummaryWith({ displayName: "origin/main hook" }),
    });
    signInAs("account-a");
    const retry = await screen.findByRole("button", { name: "Retry" });

    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't complete the sandbox action.",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await userEvent.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox.mock.calls).toHaveLength(2),
    );

    expect(
      binding.auth.createSandbox.mock.calls.map(([request]) => request),
    ).toMatchObject([
      { displayName: "origin/main hook" },
      {
        clientRequestId: "retry:sbx_ordinary_failed",
        displayName: "origin/main hook",
      },
    ]);
    view.unmount();
  });

  it.each([
    ["window A", 0],
    ["window B", 1],
  ] as const)(
    "uses one named-402 Retry reservation from %s with the failed row's creator and name",
    async (_window, firstWindowIndex) => {
      const user = userEvent.setup();
      const binding = createFakeSandboxBinding();
      const initialKey = `retry:${FAILED_SANDBOX_ID}`;
      const retryRow = failedRowSummaryWith({
        id: "sbx_named_402",
        state: "destroyed",
        failureCode: "credit-gate",
        displayName: "origin/main hook",
        createdByTaskId: "origin-task",
      });
      const walk = createSandboxRetryWalkFake(initialKey, undefined);
      walk.refuseNamed402(initialKey, retryRow);
      binding.auth.createSandbox.mockImplementation(walk.create);
      const initialRow = failedRowSummaryWith({
        createdByTaskId: "origin-task",
        displayName: "origin/main hook",
      });
      const renderCard = () =>
        renderFailedRowWithSummary({
          binding,
          configuration: PERSONAL_CONFIGURATION,
          environmentRole: "editor",
          queryClient: createQueryClient(),
          summary: initialRow,
        });
      const firstWindow = renderCard();
      const firstRetry = await within(firstWindow.container).findByRole(
        "button",
        { name: "Retry" },
      );
      const secondWindow = renderCard();
      const secondRetry = await within(secondWindow.container).findByRole(
        "button",
        { name: "Retry" },
      );
      signInAs("account-a");
      const firstInOrder = firstWindowIndex === 0 ? firstRetry : secondRetry;
      const secondInOrder = firstWindowIndex === 0 ? secondRetry : firstRetry;
      await user.click(firstInOrder);
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
      await user.click(secondInOrder);
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2));
      expect(mocks.toastError).toHaveBeenNthCalledWith(
        1,
        "The team's credits don't cover an hour of this sandbox. Add $0.12 and try again.",
      );
      expect(mocks.toastError).toHaveBeenNthCalledWith(
        2,
        "Couldn't start origin/main hook",
      );
      expect(walk.requests.slice(0, 2)).toMatchObject([
        {
          clientRequestId: initialKey,
          createdByTaskId: "origin-task",
          displayName: "origin/main hook",
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
        },
        {
          clientRequestId: initialKey,
          createdByTaskId: "origin-task",
          displayName: "origin/main hook",
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
        },
      ]);
      await waitFor(() => expect(firstRetry).toHaveProperty("disabled", false));
      await waitFor(() =>
        expect(secondRetry).toHaveProperty("disabled", false),
      );

      await user.click(firstInOrder);
      await user.click(secondInOrder);
      const nextKey = "retry:sbx_named_402";
      await Promise.all([
        walk.waitForArrival(nextKey, 1),
        walk.waitForArrival(nextKey, 2),
      ]);
      act(() => {
        walk.answer(nextKey, 1, { state: "awake" });
        walk.answer(nextKey, 2, { state: "awake" });
      });
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(2));

      expect(walk.requests.map((request) => request.clientRequestId)).toEqual([
        initialKey,
        initialKey,
        nextKey,
        nextKey,
      ]);
      expect(walk.requests.slice(2)).toEqual([
        {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: 20480,
          region: "us-east",
          displayName: "origin/main hook",
          idleMinutes: null,
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
          environmentId: "env-acme",
          destroyAfterRestingMinutes: 0,
          createdByTaskId: "origin-task",
          clientRequestId: nextKey,
        },
        {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: 20480,
          region: "us-east",
          displayName: "origin/main hook",
          idleMinutes: null,
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
          environmentId: "env-acme",
          destroyAfterRestingMinutes: 0,
          createdByTaskId: "origin-task",
          clientRequestId: nextKey,
        },
      ]);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Created origin/main hook",
      );
      firstWindow.unmount();
      secondWindow.unmount();
    },
  );

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
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't complete the sandbox action.",
      ),
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

  it("keeps a failed row's canonical Retry payload after a row-less shape 400", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    const queryClient = createQueryClient();
    const initialSummary = failedRowSummaryWith({
      displayName: "origin/main hook",
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: 720,
      createdByTaskId: "origin-task",
    });
    const refreshedSummary = failedRowSummaryWith({
      displayName: "refreshed row name",
      os: "linux",
      cpus: 6,
      memoryMb: 12_288,
      diskMb: 61_440,
      region: "us-east",
      idleMinutes: 15,
      destroyAfterRestingMinutes: 360,
      createdByTaskId: "refreshed-task",
    });
    const savedRequest = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      region: "us-east",
      displayName: "origin/main hook",
      idleMinutes: 30,
      burst: false,
      createdByHostId: null,
      createdByAgentId: null,
      environmentId: "env-acme",
      destroyAfterRestingMinutes: 720,
      createdByTaskId: "origin-task",
      clientRequestId: `retry:${FAILED_SANDBOX_ID}`,
    };
    binding.auth.createSandbox
      .mockResolvedValueOnce(
        refusal(400, SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED),
      )
      .mockResolvedValueOnce({ kind: "network-error", detail: "offline" });
    const billingAnswer = { kind: "ready", role: "editor" } as const;
    const onBinding = (
      runtimeBinding: HostRuntimeBinding<HostRpcRegistry>,
    ): void => {
      vi.spyOn(runtimeBinding.auth, "getTeamEnvironment").mockImplementation(
        (teamId) => binding.auth.getTeamEnvironment(teamId),
      );
      vi.spyOn(runtimeBinding.auth, "createSandbox").mockImplementation(
        (request) => binding.auth.createSandbox(request),
      );
    };
    const view = render(
      <SandboxBillingRuntime
        answer={billingAnswer}
        hostId="billing-host"
        environmentId="env-acme"
        queryClient={queryClient}
        onBinding={onBinding}
        onEnvironmentListRead={null}
      >
        <RefreshableFailedRowSummary
          initial={initialSummary}
          refreshed={refreshedSummary}
        />
      </SandboxBillingRuntime>,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("viewer");

    await user.click(retry);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map(({ state }) => state.error),
    ).toContainEqual(expect.objectContaining({ nextRequest: savedRequest }));
    await user.click(screen.getByRole("button", { name: "Refresh row" }));
    expect(
      await screen.findByRole("button", { name: "Destroy refreshed row name" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);

    await user.click(retry);
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2));
    expect(binding.auth.createSandbox.mock.calls).toMatchObject([
      [savedRequest],
      [savedRequest],
    ]);
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("uses the current failed row key after the mounted card changes rows", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    const queryClient = createQueryClient();
    const initialSummary = failedRowSummaryWith({
      id: "failed-row-X",
      displayName: "row X",
    });
    const refreshedSummary = failedRowSummaryWith({
      id: "failed-row-Y",
      displayName: "row Y",
    });
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
        sandboxId: initialSummary.id,
      })
      .mockResolvedValueOnce({ kind: "network-error", detail: "offline" });
    const view = render(
      <SandboxBillingRuntime
        answer={{ kind: "ready", role: "editor" }}
        hostId="billing-host"
        environmentId="env-acme"
        queryClient={queryClient}
        onBinding={(runtimeBinding: HostRuntimeBinding<HostRpcRegistry>) => {
          vi.spyOn(
            runtimeBinding.auth,
            "getTeamEnvironment",
          ).mockImplementation((teamId) =>
            binding.auth.getTeamEnvironment(teamId),
          );
          vi.spyOn(runtimeBinding.auth, "createSandbox").mockImplementation(
            (request) => binding.auth.createSandbox(request),
          );
        }}
        onEnvironmentListRead={null}
      >
        <RefreshableFailedRowSummary
          initial={initialSummary}
          refreshed={refreshedSummary}
        />
      </SandboxBillingRuntime>,
    );
    signInAs("viewer");

    const retryX = await screen.findByRole("button", { name: "Retry" });
    await user.click(retryX);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retryX).toHaveProperty("disabled", false));
    expect(binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId).toBe(
      "retry:failed-row-X",
    );

    await user.click(screen.getByRole("button", { name: "Refresh row" }));
    const retryY = await screen.findByRole("button", { name: "Retry" });
    await user.click(retryY);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2));

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual(["retry:failed-row-X", "retry:failed-row-Y"]);
    expect(binding.auth.createSandbox.mock.calls[1]?.[0].displayName).toBe(
      "row Y",
    );
    view.unmount();
  });

  it("reports a joined destroying row, then reuses the pressed key and walks after it is destroyed", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    const transitioningRow = sandboxSummaryFixture({
      id: "holder-under-destroy",
      hostId: "host-holder-under-destroy",
      state: "destroying",
      displayName: "origin/main hook",
    });
    const destroyedRow = { ...transitioningRow, state: "destroyed" as const };
    const awakeRow = sandboxSummaryFixture({
      id: "awake-after-destroy",
      hostId: "host-awake-after-destroy",
      state: "awake",
      displayName: "origin/main hook",
    });
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: transitioningRow.id,
          hostId: transitioningRow.hostId,
          sandbox: transitioningRow,
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: destroyedRow.id,
          hostId: destroyedRow.hostId,
          sandbox: destroyedRow,
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        accepted: {
          sandboxId: awakeRow.id,
          hostId: awakeRow.hostId,
          sandbox: awakeRow,
        },
      });
    const view = renderFailedRowWithSummary({
      binding,
      configuration: PERSONAL_CONFIGURATION,
      environmentRole: "editor",
      queryClient: createQueryClient(),
      summary: failedRowSummaryWith({ displayName: "origin/main hook" }),
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    signInAs("viewer");

    await user.click(retry);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This sandbox is changing state. Try again in a moment.",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1);
    expect(binding.auth.createSandbox.mock.calls[0]?.[0].clientRequestId).toBe(
      `retry:${FAILED_SANDBOX_ID}`,
    );
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));

    await user.click(retry);
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Created origin/main hook",
      ),
    );
    expect(binding.auth.createSandbox).toHaveBeenCalledTimes(3);
    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([
      `retry:${FAILED_SANDBOX_ID}`,
      `retry:${FAILED_SANDBOX_ID}`,
      "retry:holder-under-destroy",
    ]);
    view.unmount();
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

  it("retains the attempted holder key after an unnamed 402 follows a joined destroyed row", async () => {
    const user = userEvent.setup();
    const binding = createFakeSandboxBinding();
    binding.auth.createSandbox
      .mockResolvedValueOnce({
        kind: "ok",
        joined: true,
        accepted: {
          sandboxId: "sbx_holder_before_402",
          hostId: "host-holder-before-402",
          sandbox: sandboxSummaryFixture({
            id: "sbx_holder_before_402",
            state: "destroyed",
            failureCode: "PROVIDER_CREATE_FAILED",
          }),
        },
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
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));

    expect(
      binding.auth.createSandbox.mock.calls.map(
        ([request]) => request.clientRequestId,
      ),
    ).toEqual([
      `retry:${FAILED_SANDBOX_ID}`,
      "retry:sbx_holder_before_402",
      "retry:sbx_holder_before_402",
    ]);
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

  it.each([
    ["503", false],
    ["a rejected IPC promise", true],
  ] as const)(
    "re-walks from the key chosen for the press after %s interrupts the walk",
    async (_name, rejects) => {
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
      const create = binding.auth.createSandbox
        .mockResolvedValueOnce({
          ...refusedCreate(),
          status: 502,
          code: "provider_failed",
          sandboxId: "shown-failure",
        })
        .mockResolvedValueOnce(joinedDestroyed);
      if (rejects) {
        create.mockRejectedValueOnce(new Error("IPC rejected the create"));
      } else {
        create.mockResolvedValueOnce({
          kind: "refused",
          status: 503,
          code: "provider_unavailable",
          reason: null,
          shortfallMc: null,
          newRateMcPerHour: null,
          currentAwakeBurnMcPerHour: null,
          message: null,
        });
      }
      create.mockResolvedValueOnce(joinedDestroyed).mockResolvedValueOnce({
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
      expect(mocks.toastError.mock.calls[1]?.[0]).toBe(
        rejects
          ? "Couldn't create the sandbox."
          : "Sandboxes aren't available right now. Try again later.",
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
    },
  );

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
    ["window A first sees awake", 0, "awake"],
    ["window A first sees failed", 0, "failed"],
    ["window B first sees awake", 1, "awake"],
    ["window B first sees failed", 1, "failed"],
  ] as const)(
    "joins each held key across both windows when %s",
    async (_arrival, firstWindowIndex, firstState) => {
      const user = userEvent.setup();
      const binding = createFakeSandboxBinding();
      const initialKey = `retry:${FAILED_SANDBOX_ID}`;
      const walk = createSandboxRetryWalkFake(initialKey, undefined);
      binding.auth.createSandbox.mockImplementation(walk.create);

      const firstWindow = renderFailedRow(
        binding,
        PERSONAL_CONFIGURATION,
        "editor",
        createQueryClient(),
      );
      const firstButton = await within(firstWindow.container).findByRole(
        "button",
        { name: "Retry" },
      );
      const secondWindow = renderFailedRow(
        binding,
        PERSONAL_CONFIGURATION,
        "editor",
        createQueryClient(),
      );
      const secondButton = await within(secondWindow.container).findByRole(
        "button",
        { name: "Retry" },
      );
      signInAs("account-a");
      const firstInOrder = firstWindowIndex === 0 ? firstButton : secondButton;
      const secondInOrder = firstWindowIndex === 0 ? secondButton : firstButton;
      await user.click(firstInOrder);
      await user.click(secondInOrder);

      const oneWalk = [
        initialKey,
        "retry:holder-1",
        "retry:holder-2",
        "retry:holder-3",
        "retry:holder-4",
        "retry:holder-5",
      ];
      for (let step = 0; step < 4; step += 1) {
        const key = oneWalk.at(step);
        if (key === undefined) throw new Error("expected a walk key");
        await Promise.all([
          walk.waitForArrival(key, 1),
          walk.waitForArrival(key, 2),
        ]);
        expect(firstButton).toHaveProperty("disabled", true);
        expect(secondButton).toHaveProperty("disabled", true);
        act(() => {
          walk.answer(key, 1, { state: "destroyed" });
          walk.answer(key, 2, { state: "destroyed" });
        });
      }
      const transitionKey = oneWalk.at(4);
      const finalKey = oneWalk.at(-1);
      if (transitionKey === undefined || finalKey === undefined)
        throw new Error("expected the transition and final keys");
      await Promise.all([
        walk.waitForArrival(transitionKey, 1),
        walk.waitForArrival(transitionKey, 2),
      ]);
      const firstResultOrdinal = 1;
      const secondResultOrdinal = 2;
      act(() =>
        walk.answer(transitionKey, firstResultOrdinal, { state: firstState }),
      );
      if (firstState === "failed") {
        await waitFor(() =>
          expect(mocks.toastError).toHaveBeenCalledWith(
            "Couldn't complete the sandbox action.",
          ),
        );
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
      } else {
        await waitFor(() =>
          expect(mocks.toastSuccess).toHaveBeenCalledTimes(1),
        );
      }
      act(() =>
        walk.answer(transitionKey, secondResultOrdinal, { state: "destroyed" }),
      );
      await walk.waitForArrival(finalKey, 1);
      expect(secondInOrder).toHaveProperty("disabled", true);
      act(() => walk.answer(finalKey, 1, { state: "awake" }));
      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledTimes(
          firstState === "failed" ? 1 : 2,
        ),
      );
      expect(walk.requests.map((request) => request.clientRequestId)).toEqual([
        ...oneWalk.slice(0, 5).flatMap((key) => [key, key]),
        finalKey,
      ]);
      firstWindow.unmount();
      secondWindow.unmount();
    },
  );
});
