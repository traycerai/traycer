import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  refreshHostFleet: vi.fn(),
  requestFleetRefresh: vi.fn(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    refreshHostFleet: mocks.refreshHostFleet,
    signInUrl: "https://example.test",
  }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({
  requestFleetRefresh: mocks.requestFleetRefresh,
}));

const FROZEN_AT = Date.UTC(2026, 9, 20, 6, 21);

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
  });
}

function renderFooter(state: ChatSandboxState): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSandboxFooter
        line={
          resolveChatSandbox(state, {
            reachable: false,
            canEdit: true,
            ownedByViewer: true,
            environmentOwned: false,
            staysReadable: true,
          }).line
        }
      />
    </QueryClientProvider>,
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
    lastContactAt: Date.now() - 7 * 60_000 - 20_000,
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
    wakeChangesPayer: false,
  };
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
  mocks.refreshHostFleet.mockReset();
  mocks.requestFleetRefresh.mockReset();
  signedInAs("viewer");
});

afterEach(() => {
  cleanup();
  mocks.binding = null;
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

    renderFooter(unreachable());
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

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

    renderFooter(unreachable());
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

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

      renderFooter(frozenTeam(state));
      const action = screen.getByRole("button", {
        name: /resume using my acme credits/i,
      });
      await userEvent.click(action);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(`Couldn't ${verb} e2e-sbx-team`);
      expect(alert.textContent).toContain("Acme allowance");
      expect(alert.textContent).toContain("$1.25");
      expect(alert.textContent).toContain("wakes it for an hour");
      expect(screen.getByRole("button", { name: /add credits/i })).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(
        binding.auth.runSandboxVerb.mock.calls.map((call) => call[1]),
      ).toEqual([verb, verb]);
    },
  );
});
