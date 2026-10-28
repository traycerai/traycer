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
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { PendingSandboxSendForChat } from "@/components/sandboxes/pending-sandbox-sends";

const SEND_ID = "pending-stop-credit";
const SANDBOX_ID = "sandbox-pending-stop";
const SANDBOX_HOST_ID = "host-pending-stop";
const CHAT_ID = "existing-chat";
const SURFACE = pendingSendSurfaceKey(SEND_ID);
let restoreLock = (): void => undefined;

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
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/sandboxes/use-on-team-sandbox", () => ({
  useSandboxHostConfiguration: () => null,
}));
vi.mock("@/hooks/sandboxes/use-open-configuration-providers", () => ({
  useConfigurationProvidersOpener: () => () => undefined,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ ready: true, data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-list-query")
  >()),
  // The held message's sandbox is awake: Stop is offered on it.
  useSandboxList: () => ({
    data: {
      sandboxes: [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST_ID,
          state: "awake",
        }),
      ],
    },
    dataUpdatedAt: Date.now(),
    isError: false,
    refetch: () => Promise.resolve(undefined),
  }),
}));
vi.mock(
  "@/components/composer/use-staged-sandbox-send",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/composer/use-staged-sandbox-send")
    >()),
    useStagedSandboxRunner: () => () => undefined,
    useNewHostActions: () => ({
      onRetryApplying: null,
      onRepairSetup: null,
      repairSetupPending: false,
      applyingPending: false,
      applyingError: false,
      onOpenTerminal: null,
    }),
  }),
);

const TEAM_TARGET: StagedSandboxTarget = {
  kind: "existing",
  hostId: SANDBOX_HOST_ID,
  sandboxId: SANDBOX_ID,
  name: "api-refactor",
  configuration: { kind: "team", teamId: "team-acme", teamName: "Acme" },
  verb: "resume",
};

function signIn(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.test" },
      { userId: "user-1", username: "U" },
      [],
    );
}

function seedPendingMessage(): void {
  usePendingSandboxSendStore.getState().add(
    pendingSend({
      id: SEND_ID,
      request: { kind: "message", chatId: CHAT_ID },
    }),
  );
  const stageStore = useStagedSandboxStore.getState();
  stageStore.stage(SURFACE, TEAM_TARGET);
  stageStore.begin(SURFACE, false, Date.now() - 24_000, false);
  stageStore.report(SURFACE, {
    ownerId: null,
    sendTaken: true,
    step: "delivering",
    stepAt: Date.now(),
    createdSandboxId: SANDBOX_ID,
    createdHostId: SANDBOX_HOST_ID,
    phase: "handoff",
    failure: { kind: "settings", code: "SBX-0520" },
  });
}

function installExclusiveSendLock(): () => void {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<void>,
      ) => callback(),
    },
  });
  return () => {
    if (originalLocks === undefined) Reflect.deleteProperty(navigator, "locks");
    else Object.defineProperty(navigator, "locks", originalLocks);
  };
}

function renderPendingMessage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, gcTime: 0 },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PendingSandboxSendForChat
        epicId="epic-1"
        chatId={CHAT_ID}
        tabId="tab-1"
      />
    </QueryClientProvider>,
  );
}

function teamAllowanceRefusal(): Extract<
  SandboxControlFailure,
  { readonly kind: "refused" }
> {
  return {
    ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
    shortfallMc: 1_250,
    creditSource: "team-allowance",
  };
}

beforeEach(() => {
  restoreLock = (): void => undefined;
  localStorage.clear();
  sessionStorage.clear();
  mocks.binding = createFakeSandboxBinding();
  mocks.refreshHostFleet.mockReset();
  mocks.requestFleetRefresh.mockReset();
  signIn();
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
});

afterEach(() => {
  cleanup();
  restoreLock();
  mocks.binding = null;
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  useAuthStore.getState().setSignedOut();
});

describe("pending chat Stop failures", () => {
  it("keeps the team credit refusal detail on the held message and retries Stop", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the sandbox binding is missing");
    binding.auth.runSandboxVerb
      .mockResolvedValueOnce(teamAllowanceRefusal())
      .mockResolvedValueOnce({ kind: "ok", settled: true, state: "stopped" });
    restoreLock = installExclusiveSendLock();
    seedPendingMessage();
    renderPendingMessage();

    await userEvent.click(await screen.findByTestId("sandbox-setup-stop"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't stop api-refactor");
    expect(alert.textContent).toContain("Acme allowance");
    expect(alert.textContent).toContain("$1.25");
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
    expect(
      within(alert).getByRole("button", { name: /add credits/i }),
    ).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();

    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(binding.auth.runSandboxVerb.mock.calls).toHaveLength(2);
    });
    expect(
      binding.auth.runSandboxVerb.mock.calls.map(([, verb]) => verb),
    ).toEqual(["stop", "stop"]);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID],
    ).toBeUndefined();
  });
});
