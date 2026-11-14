import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT } from "@traycer/protocol/host/sandbox-control";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { ChatSandboxFooter } from "@/components/chat/chat-sandbox-footer";
import {
  resolveChatSandbox,
  type ChatSandboxState,
} from "@/lib/sandboxes/chat-sandbox-state";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@/lib/host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  environmentRole: "admin" as "admin" | "editor",
  requestFleetRefresh: vi.fn(),
  useRuntimeBinding: false,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () =>
      mocks.useRuntimeBinding ? actual.useHostBinding() : mocks.binding,
  };
});
vi.mock("@/lib/host/fleet-refresh", () => ({
  requestFleetRefresh: mocks.requestFleetRefresh,
}));

const FROZEN_AT = Date.UTC(2026, 9, 20, 6, 21);
const LOCAL_HOST: LocalHostSnapshot = {
  hostId: "billing-host",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "test-machine",
  displayName: "test-machine",
  availability: "available",
};

const environmentListRequests: (string | null)[] = [];

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
  });
}

function renderFooter(state: ChatSandboxState): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  if (state.kind === "resting" && state.configuration.kind === "team") {
    mocks.binding?.auth.getTeamEnvironment.mockResolvedValue({
      kind: "ok",
      environmentId: "team-a",
    });
  }
  mocks.useRuntimeBinding = true;
  render(
    <SandboxBillingRuntime
      answer={{ kind: "ready", role: mocks.environmentRole }}
      environmentId="team-a"
      hostId="billing-host"
      queryClient={queryClient}
      onBinding={(runtimeBinding: HostRuntimeBinding<HostRpcRegistry>) => {
        const fakeBinding = mocks.binding;
        if (fakeBinding === null) {
          throw new Error("the fake AuthService answers were not prepared");
        }
        vi.spyOn(runtimeBinding.auth, "getTeamEnvironment").mockImplementation(
          (teamId) => fakeBinding.auth.getTeamEnvironment(teamId),
        );
        vi.spyOn(runtimeBinding.auth, "runSandboxVerb").mockImplementation(
          (sandboxId, verb, gesture, timeoutMs) =>
            fakeBinding.auth.runSandboxVerb(
              sandboxId,
              verb,
              gesture,
              timeoutMs,
            ),
        );
      }}
      onEnvironmentListRequest={(hostId) => {
        environmentListRequests.push(hostId);
      }}
    >
      <ChatSandboxFooter
        line={
          resolveChatSandbox(state, {
            reachable: false,
            ownedByViewer: true,
            environmentOwned: false,
          }).line
        }
      />
    </SandboxBillingRuntime>,
  );
  return queryClient;
}

function renderUnreachableFooter(state: ChatSandboxState): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: LOCAL_HOST,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  mocks.useRuntimeBinding = false;
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <ChatSandboxFooter
          line={
            resolveChatSandbox(state, {
              reachable: false,
              ownedByViewer: true,
              environmentOwned: false,
            }).line
          }
        />
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

function unreachable(): ChatSandboxState {
  return {
    kind: "unreachable",
    sandbox: sandboxSummaryFixture({
      id: "sbx-unreachable",
      displayName: "e2e-sbx-live",
      state: "awake",
    }),
    lastSeenAt: Date.now() - 7 * 60_000 - 20_000,
  };
}

function frozenTeam(state: "stopped" | "suspended"): ChatSandboxState {
  return {
    kind: "resting",
    sandbox: sandboxSummaryFixture({
      id: "sbx-frozen-team",
      displayName: "e2e-sbx-team",
      state,
      environmentId: "team-a",
      frozen: true,
      frozenAt: FROZEN_AT,
    }),
    configuration: { kind: "team", teamId: "team-a", teamName: "Acme" },
  };
}

async function waitForEnvironmentList(queryClient: QueryClient): Promise<void> {
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

function insufficientCreditRefusal(): Extract<
  SandboxControlFailure,
  { readonly kind: "refused" }
> {
  return {
    kind: "refused",
    status: 402,
    code: SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
    reason: null,
    shortfallMc: 1_250,
    creditSource: "team-allowance",
    newRateMcPerHour: null,
    currentAwakeBurnMcPerHour: null,
    message: null,
  };
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.environmentRole = "admin";
  mocks.useRuntimeBinding = false;
  environmentListRequests.length = 0;
  mocks.requestFleetRefresh.mockReset();
  signedInAs("viewer");
});

afterEach(() => {
  cleanup();
  mocks.binding = null;
  mocks.useRuntimeBinding = false;
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
  });
});

describe("<ChatSandboxFooter /> lifecycle failures", () => {
  it("shows a refused Stop with Retry, hides it for another account, and retries the same Stop", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the sandbox binding is missing");
    binding.auth.runSandboxVerb.mockResolvedValueOnce(
      refusal(409, "sandbox_busy"),
    );

    renderUnreachableFooter(unreachable());
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't stop e2e-sbx-live");
    expect(alert.textContent).toContain("SBX-0701");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    signedInAs("other-viewer");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    signedInAs("viewer");
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(binding.auth.runSandboxVerb.mock.calls).toEqual([
      ["sbx-unreachable", "stop", null, expect.any(Number)],
      ["sbx-unreachable", "stop", null, expect.any(Number)],
    ]);
  });

  it("shows a failed Stop with the same action-level Retry", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the sandbox binding is missing");
    binding.auth.runSandboxVerb.mockResolvedValueOnce({
      kind: "network-error",
      detail: "the host did not answer",
    });

    renderUnreachableFooter(unreachable());
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't stop e2e-sbx-live");
    expect(alert.textContent).toContain("SBX-0701");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it.each([
    { state: "stopped", verb: "start" },
    { state: "suspended", verb: "resume" },
  ] as const)(
    "shows the team credit refusal and retries the same $verb action for a frozen $state sandbox",
    async ({ state, verb }) => {
      const binding = mocks.binding;
      if (binding === null) throw new Error("the sandbox binding is missing");
      binding.auth.runSandboxVerb
        .mockResolvedValueOnce(insufficientCreditRefusal())
        .mockResolvedValueOnce({
          kind: "ok",
          settled: true,
          state: "awake",
        });

      const queryClient = renderFooter(frozenTeam(state));
      const action = await screen.findByRole("button", {
        name: "Resume",
      });
      await userEvent.click(action);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(`Couldn't ${verb} e2e-sbx-team`);
      expect(alert.textContent).toContain("Acme allowance");
      expect(alert.textContent).toContain("$1.25");
      expect(alert.textContent).toContain("wakes it for an hour");
      await waitForEnvironmentList(queryClient);
      expect(
        screen.getByRole("button", { name: "Add credits ↗" }),
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(
        binding.auth.runSandboxVerb.mock.calls.map((call) => call[1]),
      ).toEqual([verb, verb]);
    },
  );

  it("keeps Add credits off an Editor's frozen team refusal", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the sandbox binding is missing");
    mocks.environmentRole = "editor";
    binding.auth.runSandboxVerb.mockResolvedValueOnce(
      insufficientCreditRefusal(),
    );

    const queryClient = renderFooter(frozenTeam("suspended"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Resume" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Acme allowance");
    expect(alert.textContent).toContain("$1.25");
    expect(alert.textContent).toContain("wakes it for an hour");
    await waitForEnvironmentList(queryClient);
    expect(
      within(alert).queryByRole("button", { name: "Add credits ↗" }),
    ).toBeNull();
  });
});
