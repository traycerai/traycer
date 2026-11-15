import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { StoppedSandboxSendReceiptStrip } from "@/components/sandboxes/stopped-sandbox-send-receipts";
import {
  stoppedReceiptPicks,
  useStoppedSandboxSendReceiptStore,
  type StoppedSandboxSendReceipt,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { ReactNode } from "react";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { SandboxLifecycleVerbFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { SandboxHeaderActions } from "@/components/hosts/sandbox-card";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import type { SandboxCreditSource } from "@traycer/protocol/host/sandbox-control";
import type { SandboxRowVerb } from "@/hooks/sandboxes/use-sandbox-operation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { closeSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import {
  SandboxBillingRuntime,
  type SandboxBillingEnvironmentAnswer,
} from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { HostRuntimeContext } from "@/lib/host";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as RemoteHostDirectoryEntry | null,
  configuration: { kind: "personal" } as SandboxPageConfiguration | null,
  environmentRole: "admin" as "admin" | "editor" | "viewer" | null,
  environmentListLoading: false,
  environmentListFailed: false,
}));
const environmentListClientHosts: Array<string | null> = [];
let billingBinding: HostRuntimeBinding<HostRpcRegistry> | null = null;
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => "landing:row-operation",
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxRunner: () => vi.fn(),
  startStagedTerminal: vi.fn(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
  useSandboxRowSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
    resumePending: false,
  }),
}));
vi.mock("@/components/host/host-restart-sessions", () => ({
  KnownHostSessionsList: () => null,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-configurations")
      >();
    return {
      ...actual,
      useSandboxConfigurations: () => ({
        configurations:
          mocks.configuration === null
            ? [{ kind: "personal" as const }]
            : [{ kind: "personal" as const }, mocks.configuration],
        teamEnvironmentIds: new Set(
          mocks.configuration?.kind === "team" &&
            mocks.configuration.environmentId !== null
            ? [mocks.configuration.environmentId]
            : [],
        ),
        complete: true,
        personalEnvironmentId:
          mocks.configuration?.kind === "personal" ? "env-personal" : null,
      }),
      useSandboxWakeString: () => null,
    };
  },
);
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: undefined }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => ({ kind: "none" }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-egress-events", () => ({
  useSandboxEgressEvents: () => [],
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
  useHostMethodSupport: () => false,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: () => ({ data: undefined }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRepairGuestConfigurationOnHost: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRepairGuestSetupOnHost: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRetryApplyingSupported: () => false,
    useSandboxGuestSetupRepairSupported: () => false,
    useSandboxSettingsOperation: () => null,
  }),
);
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-sbx-1",
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));

beforeEach(() => {
  environmentListClientHosts.length = 0;
  billingBinding = null;
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  useStoppedSandboxSendReceiptStore.setState({ receipts: {}, strips: {} });
  mocks.configuration = { kind: "personal" };
  mocks.environmentRole = "admin";
  mocks.environmentListLoading = false;
  mocks.environmentListFailed = false;
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "u1", userName: "Ada", email: "ada@example.test" },
    contextMetadata: { userId: "u1", username: "ada" },
  });
});
afterEach(() => {
  cleanup();
  environmentListClientHosts.length = 0;
  closeSandboxDetails();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    profile: null,
  });
});

interface VerbCase {
  readonly verb: SandboxRowVerb;
  readonly label: string;
  readonly pending: string;
  readonly reference: string;
  readonly initial: HostSandboxState;
  readonly reached: HostSandboxState;
}
const SUSPEND_CASE: VerbCase = {
  verb: "suspend",
  label: "Suspend",
  pending: "Suspending · pending",
  reference: "SBX-0601",
  initial: "awake",
  reached: "suspended",
};
const CASES: readonly VerbCase[] = [
  {
    verb: "start",
    label: "Start",
    pending: "Starting · pending",
    reference: "SBX-0508",
    initial: "stopped",
    reached: "awake",
  },
  {
    verb: "resume",
    label: "Resume",
    pending: "Resuming · pending",
    reference: "SBX-0507",
    initial: "suspended",
    reached: "awake",
  },
  SUSPEND_CASE,
  {
    verb: "stop",
    label: "Stop",
    pending: "Stopping · pending",
    reference: "SBX-0701",
    initial: "awake",
    reached: "stopped",
  },
  {
    verb: "destroy",
    label: "Destroy",
    pending: "Destroying · pending",
    reference: "SBX-0801",
    initial: "awake",
    reached: "destroyed",
  },
];
const STOP_CASE = CASES.find((entry) => entry.verb === "stop");
if (STOP_CASE === undefined) throw new Error("Expected the Stop case");
const FROZEN_DESTROY_CASE: VerbCase = {
  verb: "destroy",
  label: "Destroy",
  pending: "Destroying · pending",
  reference: "SBX-0801",
  initial: "suspended",
  reached: "destroyed",
};

function Rows(): ReactNode {
  const list = useSandboxList();
  return list.data?.sandboxes.map((summary) => (
    <section key={summary.id} aria-label={summary.displayName}>
      <SandboxRowActions
        summary={summary}
        configuration={mocks.configuration}
        unreachable={false}
        frozenOffersAddCredits={false}
        settingsFailed={false}
      />
    </section>
  ));
}

function billingEnvironmentAnswer(): SandboxBillingEnvironmentAnswer {
  if (mocks.environmentListLoading) return { kind: "loading" };
  if (mocks.environmentListFailed) return { kind: "failed" };
  if (mocks.environmentRole === null) return { kind: "loading" };
  return { kind: "ready", role: mocks.environmentRole };
}

async function renderWithRunnerHost(children: ReactNode, client: QueryClient) {
  await waitFor(() => expect(billingBinding).not.toBeNull());
  const binding = billingBinding;
  if (binding === null) {
    throw new Error("The billing runtime binding was not prepared");
  }
  return render(
    <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
      <HostRuntimeContext.Provider value={binding}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </HostRuntimeContext.Provider>
    </RunnerHostProvider>,
  );
}

function setup(testCase: VerbCase, overrides: Partial<SandboxSummary> | null) {
  const binding = mocks.binding;
  if (binding === null) throw new Error("Expected the signed-in binding");
  if (mocks.configuration?.kind === "team") {
    binding.auth.getTeamEnvironment.mockResolvedValue({
      kind: "ok",
      environmentId: mocks.configuration.environmentId ?? "env-acme",
    });
  }
  const answer = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
  binding.auth.runSandboxVerb.mockReturnValue(answer.promise);
  binding.auth.destroySandbox.mockReturnValue(answer.promise);
  let environmentId: string | null = null;
  if (mocks.configuration?.kind === "personal") {
    environmentId = "env-personal";
  } else if (mocks.configuration?.kind === "team") {
    environmentId = mocks.configuration.environmentId;
  }
  const main = sandboxSummaryFixture({
    id: "sbx-build",
    displayName: "build-box",
    state: testCase.initial,
    environmentId,
    ...(overrides ?? {}),
  });
  const other = sandboxSummaryFixture({
    id: "sbx-other",
    displayName: "other-box",
    hostId: "host-other",
  });
  binding.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: { sandboxes: [main, other] },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <SandboxBillingRuntime
      answer={billingEnvironmentAnswer()}
      hostId="billing-host"
      environmentId={
        mocks.configuration?.kind === "team"
          ? (mocks.configuration.environmentId ?? "env-acme")
          : "env-acme"
      }
      queryClient={client}
      onBinding={(runtimeBinding: HostRuntimeBinding<HostRpcRegistry>) => {
        billingBinding = runtimeBinding;
        const fakeBinding = mocks.binding;
        if (fakeBinding === null) {
          throw new Error("the fake AuthService answers were not prepared");
        }
        vi.spyOn(runtimeBinding.auth, "getTeamEnvironment").mockImplementation(
          (teamId) => fakeBinding.auth.getTeamEnvironment(teamId),
        );
        vi.spyOn(runtimeBinding.auth, "listSandboxes").mockImplementation(() =>
          fakeBinding.auth.listSandboxes(),
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
        vi.spyOn(runtimeBinding.auth, "destroySandbox").mockImplementation(
          (sandboxId, onlyIfIdle) =>
            fakeBinding.auth.destroySandbox(sandboxId, onlyIfIdle),
        );
      }}
      onEnvironmentListRequest={(hostId) => {
        environmentListClientHosts.push(hostId);
      }}
    >
      <Rows />
      <SandboxDetailsDrawerHost />
    </SandboxBillingRuntime>,
  );
  return { answer, binding, client, main, other };
}

async function waitForEnvironmentList(
  client: QueryClient,
  result: "success" | "error" | null,
): Promise<void> {
  await waitFor(
    () => {
      expect(environmentListClientHosts).toContain("billing-host");
      if (result !== null) {
        expect(
          client
            .getQueryCache()
            .getAll()
            .some(
              (query) =>
                query.queryKey.includes("environment.list") &&
                query.state.status === result,
            ),
        ).toBe(true);
      }
    },
    {
      onTimeout: (error) => {
        const queries = client
          .getQueryCache()
          .getAll()
          .map((query) => {
            const data = query.state.data;
            const kind =
              typeof data === "object" && data !== null && "kind" in data
                ? data.kind
                : undefined;
            return {
              queryKey: query.queryKey.map((part) =>
                typeof part === "object" && part !== null
                  ? Object.keys(part)
                  : part,
              ),
              status: query.state.status,
              fetchStatus: query.state.fetchStatus,
              kind,
            };
          });
        error.message += `\nQuery state: ${JSON.stringify({ queries, environmentListClientHosts })}`;
        return error;
      },
    },
  );
}

async function press(testCase: VerbCase): Promise<HTMLElement> {
  const row = await screen.findByRole("region", { name: "build-box" });
  if (testCase.verb === "stop" || testCase.verb === "destroy") {
    await userEvent.click(
      within(row).getByRole("button", { name: "More actions for build-box" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: testCase.label }),
    );
  } else {
    await userEvent.click(
      within(row).getByRole("button", { name: testCase.label }),
    );
  }
  if (
    testCase.verb === "suspend" ||
    testCase.verb === "stop" ||
    testCase.verb === "destroy"
  ) {
    const dialog = screen.getByRole("dialog");
    if (testCase.verb === "destroy") {
      await userEvent.type(
        within(dialog).getByRole("textbox", {
          name: "Type the name to confirm",
        }),
        "build-box",
      );
    }
    await userEvent.click(
      within(dialog).getByRole("button", { name: testCase.label }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  return row;
}

/** Presses Copy diagnostics in the open Details and answers what it copied. */
async function copiedDiagnostics(): Promise<string> {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  try {
    fireEvent.click(screen.getByTestId("sandbox-details-export"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  } finally {
    if (original === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", original);
  }
  return writeText.mock.calls[0]?.[0] ?? "";
}

describe("sandbox row operations", () => {
  const TEAM_CONFIGURATION: SandboxPageConfiguration = {
    kind: "team",
    teamId: "team-acme",
    teamName: "Acme",
    environmentId: "env-acme",
  };

  it.each([
    ["Editor", "editor", false, false],
    ["Viewer", "viewer", false, false],
    ["role loading", null, true, false],
    ["environment list failed", null, false, true],
    ["Admin", "admin", false, false],
  ] as const)(
    "renders the C29 frozen refusal for a team %s on the row",
    async (
      _role,
      environmentRole,
      environmentListLoading,
      environmentListFailed,
    ) => {
      mocks.configuration = TEAM_CONFIGURATION;
      mocks.environmentRole = environmentRole;
      mocks.environmentListLoading = environmentListLoading;
      mocks.environmentListFailed = environmentListFailed;
      const resume = CASES.find((entry) => entry.verb === "resume");
      if (resume === undefined) throw new Error("Expected the Resume case");
      const { answer, client } = setup(resume, null);
      const row = await press(resume);
      await act(async () => {
        answer.resolve(refusal(402, "sandbox_frozen"));
        await answer.promise;
      });

      const failure = await within(row).findByRole("alert");
      let environmentListResult: "success" | "error" | null = null;
      if (!environmentListLoading) {
        environmentListResult = environmentListFailed ? "error" : "success";
      }
      await waitForEnvironmentList(client, environmentListResult);
      expect(failure.textContent).toContain(
        environmentRole === "admin"
          ? "Couldn't resume build-box. This sandbox is out of credits. Add credits to wake it."
          : "Couldn't resume build-box. This sandbox is out of credits. Acme's bundle is out.",
      );
    },
  );

  it("keeps today's frozen refusal sentence when the team name is unavailable", async () => {
    mocks.configuration = { ...TEAM_CONFIGURATION, teamName: "" };
    mocks.environmentRole = "admin";
    const resume = CASES.find((entry) => entry.verb === "resume");
    if (resume === undefined) throw new Error("Expected the Resume case");
    const { answer, client } = setup(resume, null);
    const row = await press(resume);
    await act(async () => {
      answer.resolve(refusal(402, "sandbox_frozen"));
      await answer.promise;
    });

    const failure = await within(row).findByRole("alert");
    await waitForEnvironmentList(client, "success");
    expect(failure.textContent).toContain(
      "Couldn't resume build-box. This sandbox is out of credits. Add credits to wake it.",
    );
  });

  it.each([
    [
      "Editor",
      false,
      "The team's credits don't cover an hour of this sandbox.",
    ],
    [
      "Admin",
      true,
      "The team's credits don't cover an hour of this sandbox. Add $1.20 and try again.",
    ],
  ] as const)(
    "shows the C29 insufficient-credit History line for a team %s",
    async (_role, buysTeamCredits, expected) => {
      mocks.configuration = TEAM_CONFIGURATION;
      mocks.environmentRole = buysTeamCredits ? "admin" : "editor";
      const resume = CASES.find((entry) => entry.verb === "resume");
      if (resume === undefined) throw new Error("Expected the Resume case");
      const { answer, client } = setup(resume, null);
      const row = await press(resume);
      await act(async () => {
        answer.resolve({
          ...refusal(402, "insufficient_credit"),
          reason: "denied",
          shortfallMc: 1_200,
          newRateMcPerHour: 1_200,
          currentAwakeBurnMcPerHour: 0,
          creditSource: "team",
        });
        await answer.promise;
      });

      const failure = await within(row).findByRole("alert");
      await waitForEnvironmentList(client, "success");
      if (buysTeamCredits) {
        expect(
          within(failure).getByRole("button", { name: "Add credits ↗" }),
        ).toBeTruthy();
      }
      await userEvent.click(
        within(failure).getByRole("button", { name: "Details" }),
      );
      expect(await screen.findByText(expected)).toBeTruthy();
    },
  );

  it.each([
    [
      "Editor",
      "editor",
      "This sandbox is out of credits. Acme's bundle is out.",
    ],
    [
      "Admin",
      "admin",
      "This sandbox is out of credits. Add credits to wake it.",
    ],
    [
      "Personal",
      "admin",
      "This sandbox is out of credits. Add credits to wake it.",
    ],
  ] as const)(
    "shows the A13 frozen History line for a team %s reader",
    async (reader, environmentRole, expected) => {
      mocks.configuration =
        reader === "Personal" ? { kind: "personal" } : TEAM_CONFIGURATION;
      mocks.environmentRole = environmentRole;
      const resume = CASES.find((entry) => entry.verb === "resume");
      if (resume === undefined) throw new Error("Expected the Resume case");
      const { answer, client } = setup(resume, null);
      const row = await press(resume);
      await act(async () => {
        answer.resolve(refusal(402, "sandbox_frozen"));
        await answer.promise;
      });

      const failure = await within(row).findByRole("alert");
      if (reader !== "Personal") {
        await waitForEnvironmentList(client, "success");
      }
      await userEvent.click(
        within(failure).getByRole("button", { name: "Details" }),
      );
      const history = await screen.findByRole("region", { name: "History" });
      expect(within(history).getByText(expected)).toBeTruthy();
    },
  );

  it("does not call an unknown sandbox's personal-source shortfall yours", async () => {
    mocks.configuration = null;
    const resume = CASES.find((entry) => entry.verb === "resume");
    if (resume === undefined) throw new Error("Expected the Resume case");
    const { answer } = setup(resume, null);
    const row = await press(resume);
    await act(async () => {
      answer.resolve({
        ...refusal(402, "insufficient_credit"),
        reason: "denied",
        shortfallMc: 210,
        newRateMcPerHour: 1_200,
        currentAwakeBurnMcPerHour: 0,
        creditSource: "personal",
      });
      await answer.promise;
    });

    const failure = await within(row).findByRole("alert");
    expect(failure.textContent).not.toContain("your credits");
    expect(failure.textContent).not.toContain("short $0.21");
    expect(failure.textContent).not.toContain("$0.21 more");
    expect(
      within(failure).queryByRole("button", { name: "Add credits ↗" }),
    ).toBeNull();
  });

  it("keeps a stopped receipt and its draft when Start fails, then clears it after a successful Retry", async () => {
    const testCase = CASES.find((entry) => entry.verb === "start");
    if (testCase === undefined) throw new Error("Expected the Start case");
    const { answer, binding, client, main } = setup(testCase, {
      environmentId: "env-personal",
    });
    const receiptUserId = useAuthStore.getState().profile?.userId ?? null;
    if (receiptUserId === null) throw new Error("Expected a signed-in reader");
    await screen.findByRole("region", { name: "build-box" });
    useNewConversationModalStore.getState().setContent("receipt-epic", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep this draft" }],
        },
      ],
    });
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        "receipt-epic"
      ]?.draftId ?? null;
    const receipt: StoppedSandboxSendReceipt = {
      id: "receipt",
      kind: "stopped",
      sandboxId: main.id,
      name: main.displayName,
      confirmedAt: Date.now() + 60_000,
      userId: receiptUserId,
      epicId: "receipt-epic",
      returned: {
        kind: "task",
        epicId: "receipt-epic",
        parentId: null,
        placement: null,
        draftId,
      },
      existingSendIds: new Set(),
      picks: stoppedReceiptPicks(
        "receipt-epic",
        useSurfaceHostSelectionStore.getState().selections,
        useStagedSandboxStore.getState().bySurface,
      ),
    };
    useStoppedSandboxSendReceiptStore.setState({ receipts: { receipt } });
    await renderWithRunnerHost(
      <StoppedSandboxSendReceiptStrip epicId="receipt-epic" tabId="tab" />,
      client,
    );
    const strip = screen.getByTestId("sandbox-stopped-line");
    await userEvent.click(within(strip).getByRole("button", { name: "Start" }));
    await act(async () => {
      answer.resolve({
        ...refusal(402, "insufficient_credit"),
        shortfallMc: 210,
        creditSource: "personal",
      });
      await answer.promise;
    });
    const alert = await within(strip).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't start build-box");
    expect(
      within(alert).getByRole("button", { name: "Add credits ↗" }),
    ).toBeDefined();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        "receipt-epic"
      ]?.draftId,
    ).toBe(draftId);
    binding.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: true,
      state: "awake",
    });
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull(),
    );
    expect(toastFromAuthError).not.toHaveBeenCalled();
  });

  it.each<{ source: SandboxCreditSource; pot: string }>([
    { source: "team-allowance", pot: "your pool-e2e-fixture allowance is" },
    { source: "team", pot: "pool-e2e-fixture's credits are" },
    { source: "personal", pot: "your credits are" },
  ])(
    "keeps a $source refusal and remedies on the row without a toast",
    async ({ source, pot }) => {
      mocks.configuration =
        source === "personal"
          ? { kind: "personal" }
          : {
              kind: "team",
              teamId: "team-a",
              teamName: "pool-e2e-fixture",
              environmentId: "team-env",
            };
      const testCase = CASES.find((entry) => entry.verb === "resume");
      if (testCase === undefined) throw new Error("Expected the Resume case");
      const { answer, client } = setup(testCase, null);
      const row = await press(testCase);
      await act(async () => {
        answer.resolve({
          kind: "refused",
          status: 402,
          code: "insufficient_credit",
          reason: "denied",
          shortfallMc: 210,
          newRateMcPerHour: 210,
          currentAwakeBurnMcPerHour: 0,
          message: null,
          creditSource: source,
        });
        await answer.promise;
      });
      const failure = await within(row).findByRole("alert");
      if (mocks.configuration.kind === "team") {
        await waitForEnvironmentList(client, "success");
      }
      expect(failure.textContent).toContain(
        `Couldn't resume build-box · ${pot} short $0.21. $0.21 more wakes it for an hour.`,
      );
      expect(
        within(failure)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Add credits ↗", "Retry", "Details"]);
      expect(toastFromAuthError).not.toHaveBeenCalled();
    },
  );

  it("keeps an unknown credit source generic on a team resume refusal", async () => {
    mocks.configuration = {
      kind: "team",
      teamId: "team-a",
      teamName: "Acme",
      environmentId: "team-env",
    };
    const testCase = CASES.find((entry) => entry.verb === "resume");
    if (testCase === undefined) throw new Error("Expected the Resume case");
    const { answer, client } = setup(testCase, null);
    const row = await press(testCase);
    await act(async () => {
      answer.resolve({
        ...refusal(402, "insufficient_credit"),
        creditSource: null,
        shortfallMc: null,
      });
      await answer.promise;
    });
    const failure = await within(row).findByRole("alert");
    await waitForEnvironmentList(client, "success");
    expect(failure.textContent).toContain(
      "Couldn't resume build-box · not enough credits to wake this sandbox for an hour.",
    );
    expect(
      within(failure)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add credits ↗", "Retry", "Details"]);
    expect(toastFromAuthError).not.toHaveBeenCalled();
  });

  it("shows the Settings dialog's pending operation and its failure on the card too", async () => {
    const { answer, client, main } = setup(SUSPEND_CASE, null);
    const sandbox: HostScopeSandbox = {
      state: main.state,
      frozen: false,
      summary: main,
      ownerKind: "unknown",
      teamOwned: false,
    };
    await renderWithRunnerHost(
      <div data-testid="sandbox-header-actions">
        <SandboxHeaderActions
          hostName={main.displayName}
          sandbox={sandbox}
          onDestroyed={null}
          renderActions={null}
        />
      </div>,
      client,
    );
    const headerActions = screen.getByTestId("sandbox-header-actions");
    await press(SUSPEND_CASE);
    expect((await within(headerActions).findByRole("status")).textContent).toBe(
      SUSPEND_CASE.pending,
    );
    const pendingButtons = screen.getAllByRole("button", {
      name: SUSPEND_CASE.pending,
    });
    expect(pendingButtons).toHaveLength(2);
    expect(
      pendingButtons.every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await userEvent.click(
      within(headerActions).getByRole("button", {
        name: "More actions for build-box",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Destroy" }),
    );
    const destroyDialog = screen.getByRole("dialog");
    await userEvent.type(
      within(destroyDialog).getByRole("textbox", {
        name: "Type the name to confirm",
      }),
      "build-box",
    );
    expect(
      within(destroyDialog)
        .getByRole("button", { name: "Destroy" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await userEvent.click(
      within(destroyDialog).getByRole("button", { name: "Cancel" }),
    );
    await act(async () => {
      answer.resolve(refusal(409, "sandbox_busy"));
      await answer.promise;
    });
    const failure = await within(headerActions).findByRole("alert");
    expect(failure.textContent).toContain(
      "Couldn't suspend build-box. It's in use (an agent turn or a running shell), so it stays awake.",
    );
    expect(failure.textContent).toContain("Support reference: SBX-0601");
    await userEvent.click(
      within(failure).getByRole("button", { name: "Details" }),
    );
    expect(
      (await screen.findByRole("region", { name: "History" })).textContent,
    ).not.toContain("sandbox_busy");
    await userEvent.keyboard("{Escape}");
    const retried = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
    mocks.binding?.auth.runSandboxVerb.mockReturnValue(retried.promise);
    await userEvent.click(
      within(failure).getByRole("button", { name: "Retry" }),
    );
    expect((await within(headerActions).findByRole("status")).textContent).toBe(
      SUSPEND_CASE.pending,
    );
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(2);
    await act(async () => {
      retried.resolve({ kind: "ok", settled: true, state: "suspended" });
      await retried.promise;
    });
  });

  it.each([
    {
      label: "Stop from awake",
      testCase: STOP_CASE,
      frozen: false,
      pending: "Stopping · pending",
    },
    {
      label: "Destroy while frozen",
      testCase: FROZEN_DESTROY_CASE,
      frozen: true,
      pending: "Destroying · pending",
    },
  ])(
    "keeps the $label pending notice outside More while the row is stale",
    async ({ testCase, frozen, pending }) => {
      const { answer, client, main } = setup(testCase, { frozen });
      const row = await press(testCase);
      const sandbox: HostScopeSandbox = {
        state: testCase.initial,
        frozen,
        summary: main,
        ownerKind: "unknown",
        teamOwned: false,
      };
      await renderWithRunnerHost(
        <div data-testid="sandbox-header-actions">
          <SandboxHeaderActions
            hostName={main.displayName}
            sandbox={sandbox}
            onDestroyed={null}
            renderActions={null}
          />
        </div>,
        client,
      );

      const headerActions = screen.getByTestId("sandbox-header-actions");
      const notice = await within(headerActions).findByRole("status");
      expect(notice.textContent).toBe(pending);
      await userEvent.click(
        within(headerActions).getByRole("button", {
          name: "More actions for build-box",
        }),
      );
      const menu = await screen.findByRole("menu");
      expect(menu.contains(notice)).toBe(false);
      expect(
        within(menu)
          .getByRole("menuitem", { name: testCase.label })
          .hasAttribute("aria-disabled"),
      ).toBe(true);

      await act(async () => {
        answer.resolve({ kind: "ok", settled: true, state: testCase.reached });
        await answer.promise;
      });
      await waitFor(() =>
        expect(within(headerActions).queryByRole("status")).toBeNull(),
      );
      expect(within(row).queryByRole("alert")).toBeNull();
    },
  );

  it("disables the tile's wake button while the Settings row wakes that sandbox", async () => {
    const testCase = CASES.find((entry) => entry.verb === "resume");
    if (testCase === undefined) throw new Error("Expected the Resume case");
    const { answer, client, main } = setup(testCase, null);
    mocks.entry = {
      ...sandboxHostEntry(main.hostId, null),
      sandbox: {
        state: "suspended",
        frozen: false,
        profile: "agent",
        ownerTeamName: null,
        ownerTeamId: null,
      },
    };
    await renderWithRunnerHost(
      <SandboxTileStateFrame chat={null}>
        <textarea aria-label="Tile body" />
      </SandboxTileStateFrame>,
      client,
    );
    const wake = await screen.findByTestId("sandbox-tile-overlay-wake");
    expect(wake.hasAttribute("disabled")).toBe(false);
    await press(testCase);
    await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(true));
    expect(wake.textContent).toContain("Resume");
    await act(async () => {
      answer.resolve({ kind: "ok", settled: true, state: "awake" });
      await answer.promise;
    });
    await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(false));
  });

  it("shows the same operation in another mounted view of that sandbox", async () => {
    const testCase = SUSPEND_CASE;
    const { answer, client, main } = setup(testCase, null);
    await renderWithRunnerHost(
      <section aria-label="Another view">
        <SandboxRowActions
          summary={main}
          configuration={mocks.configuration}
          unreachable={false}
          frozenOffersAddCredits={false}
          settingsFailed={false}
        />
      </section>,
      client,
    );
    await press(testCase);
    const otherView = screen.getByRole("region", { name: "Another view" });
    expect((await within(otherView).findByRole("status")).textContent).toBe(
      testCase.pending,
    );
    expect(
      within(otherView)
        .getByRole("button", { name: testCase.pending })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      answer.resolve({ kind: "ok", settled: true, state: "suspended" });
      await answer.promise;
    });
  });

  it("closes an open Stop confirmation when the row suspends, sends nothing, and keeps it closed when the row wakes", async () => {
    const { binding, client, main, other } = setup(STOP_CASE, null);
    const row = await screen.findByRole("region", { name: "build-box" });
    await userEvent.click(
      within(row).getByRole("button", { name: "More actions for build-box" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Stop" }),
    );
    expect(screen.getByRole("dialog").textContent).toContain("Stop build-box?");

    const listing = async (state: HostSandboxState): Promise<void> => {
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [{ ...main, state }, other] },
      });
      await act(() => client.invalidateQueries());
    };
    await listing("suspended");
    // An open modal hides the row from role queries; look through it.
    await within(row).findByRole("button", { name: "Resume", hidden: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();

    await listing("awake");
    // An open modal hides the row from role queries; look through it.
    await within(row).findByRole("button", { name: "Suspend", hidden: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for the name again after a Destroy the row closed on its own", async () => {
    const resumeCase = CASES.find((entry) => entry.verb === "resume");
    if (resumeCase === undefined) throw new Error("Expected the Resume case");
    const { binding, client, main, other } = setup(resumeCase, null);
    const row = await screen.findByRole("region", { name: "build-box" });
    const openDestroy = async (): Promise<HTMLElement> => {
      await userEvent.click(
        within(row).getByRole("button", {
          name: "More actions for build-box",
        }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Destroy" }),
      );
      return screen.getByRole("dialog");
    };
    const listing = async (state: HostSandboxState): Promise<void> => {
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [{ ...main, state }, other] },
      });
      await act(() => client.invalidateQueries());
    };
    await userEvent.type(
      within(await openDestroy()).getByRole("textbox", {
        name: "Type the name to confirm",
      }),
      "build-box",
    );

    // Another member resumes it: the resuming row offers no Destroy.
    await listing("resuming");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await listing("awake");
    await within(row).findByRole("button", { name: "Suspend" });

    const reopened = await openDestroy();
    expect(
      within(reopened).getByRole<HTMLInputElement>("textbox", {
        name: "Type the name to confirm",
      }).value,
    ).toBe("");
    expect(
      within(reopened)
        .getByRole("button", { name: "Destroy" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("drops a Stop refused as a conflict, on the row and the card, once neither offers Stop", async () => {
    const { answer, binding, client, main, other } = setup(STOP_CASE, null);
    await waitFor(() => expect(billingBinding).not.toBeNull());
    const runtimeBinding = billingBinding;
    if (runtimeBinding === null) {
      throw new Error("The billing runtime binding was not prepared");
    }
    const card = (state: HostSandboxState) => {
      const sandbox: HostScopeSandbox = {
        state,
        frozen: false,
        summary: { ...main, state },
        ownerKind: "unknown",
        teamOwned: false,
      };
      return (
        <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
          <HostRuntimeContext.Provider value={runtimeBinding}>
            <QueryClientProvider client={client}>
              <div data-testid="sandbox-header-actions">
                <SandboxHeaderActions
                  hostName={main.displayName}
                  sandbox={sandbox}
                  onDestroyed={null}
                  renderActions={null}
                />
              </div>
            </QueryClientProvider>
          </HostRuntimeContext.Provider>
        </RunnerHostProvider>
      );
    };
    const { rerender } = render(card("awake"));
    const row = await press(STOP_CASE);
    await act(async () => {
      answer.resolve(refusal(409, "sandbox_transition_conflict"));
      await answer.promise;
    });
    // While the list still reads awake, Stop is offered and so is its Retry.
    const failure = await within(row).findByRole("alert");
    expect(failure.textContent).toContain(
      "Couldn't stop build-box. This sandbox is changing state. Try again in a moment.",
    );
    expect(failure.textContent).toContain("Support reference: SBX-0701");
    expect(within(failure).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      within(screen.getByTestId("sandbox-header-actions")).getByRole("alert")
        .textContent,
    ).toContain("Couldn't stop build-box. This sandbox is changing state.");

    binding.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [{ ...main, state: "suspended" }, other] },
    });
    await act(() => client.invalidateQueries());
    await within(row).findByRole("button", { name: "Resume" });
    expect(within(row).queryByRole("alert")).toBeNull();
    rerender(card("suspended"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses the refusal's mapped support reference before the verb's reference", async () => {
    const testCase = SUSPEND_CASE;
    const { answer } = setup(testCase, null);
    const row = await press(testCase);
    await act(async () => {
      answer.resolve(refusal(503, "provider-error"));
      await answer.promise;
    });
    const failure = await within(row).findByRole("alert");
    expect(failure.textContent).toContain(
      "Couldn't suspend build-box. Traycer refused that request.",
    );
    expect(failure.textContent).toContain("Support reference: SBX-0413");
  });

  it("keeps a pending operation and its later refusal with the account that started it", async () => {
    const testCase = SUSPEND_CASE;
    const { answer } = setup(testCase, null);
    const row = await press(testCase);
    await within(row).findByRole("status");
    act(() =>
      useAuthStore.setState({
        contextMetadata: { userId: "u2", username: "bea" },
      }),
    );
    const currentRow = await screen.findByRole("region", { name: "build-box" });
    expect(within(currentRow).queryByRole("status")).toBeNull();
    await act(async () => {
      answer.resolve(refusal(409, "sandbox_busy"));
      await answer.promise;
    });
    expect(within(currentRow).queryByRole("alert")).toBeNull();
    expect(
      within(currentRow)
        .getByRole("button", { name: "Suspend" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each(CASES)(
    "shows $verb pending on its disabled button, leaves another sandbox alone, and settles on success",
    async (testCase) => {
      const { answer, binding, main, other } = setup(testCase, null);
      const row = await press(testCase);

      expect((await within(row).findByRole("status")).textContent).toBe(
        testCase.pending,
      );
      expect(
        within(row)
          .getByRole("button", { name: testCase.pending })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        within(row)
          .getByRole("button", { name: "Details" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        within(row).queryByRole("button", {
          name: "More actions for build-box",
        }),
      ).toBeNull();
      const otherRow = screen.getByRole("region", { name: "other-box" });
      expect(within(otherRow).queryByRole("status")).toBeNull();
      expect(
        within(otherRow)
          .getByRole("button", { name: "Suspend" })
          .hasAttribute("disabled"),
      ).toBe(false);

      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes:
            testCase.verb === "destroy"
              ? [other]
              : [{ ...main, state: testCase.reached }, other],
        },
      });
      await act(async () => {
        answer.resolve({ kind: "ok", settled: true, state: testCase.reached });
        await answer.promise;
      });
      if (testCase.verb === "destroy") {
        await waitFor(() =>
          expect(
            screen.queryByRole("region", { name: "build-box" }),
          ).toBeNull(),
        );
      } else {
        const nextLabel = new Map<HostSandboxState, string>([
          ["awake", "Suspend"],
          ["stopped", "Start"],
          ["suspended", "Resume"],
        ]).get(testCase.reached);
        if (nextLabel === undefined)
          throw new Error("Expected a settled action");
        expect(
          (
            await within(row).findByRole("button", { name: nextLabel })
          ).hasAttribute("disabled"),
        ).toBe(false);
        expect(within(row).queryByRole("status")).toBeNull();
      }
    },
  );

  it.each(CASES)(
    "keeps $verb's typed refusal on the row and in Details, then Retry runs it again",
    async (testCase) => {
      const { answer, binding, client } = setup(testCase, null);
      const row = await press(testCase);
      await act(async () => {
        answer.resolve(refusal(409, "sandbox_busy"));
        await answer.promise;
      });
      const line = await within(row).findByRole("alert");
      const reason =
        "It's in use (an agent turn or a running shell), so it stays awake.";
      const sentence = `Couldn't ${testCase.verb} build-box. ${reason}`;
      expect(line.textContent).toContain(sentence);
      expect(line.textContent).toContain(
        `Support reference: ${testCase.reference}`,
      );
      // An identical list refresh must not erase the local outcome.
      await act(async () => {
        await client.invalidateQueries();
      });
      expect(within(row).getByRole("alert").textContent).toContain(sentence);
      expect(
        within(screen.getByRole("region", { name: "other-box" })).queryByRole(
          "alert",
        ),
      ).toBeNull();

      await userEvent.click(
        within(line).getByRole("button", { name: "Details" }),
      );
      const history = await screen.findByRole("region", { name: "History" });
      expect(history.textContent).toContain(
        `Couldn't ${testCase.verb} build-box`,
      );
      expect(history.textContent).toContain(reason);
      // Details shows the SBX code; the raw code goes only in the export.
      expect(history.textContent).not.toContain("Failure code");
      expect(history.textContent).not.toContain("sandbox_busy");
      expect(history.textContent).toContain(
        `Support reference: ${testCase.reference}`,
      );
      expect(await copiedDiagnostics()).toContain("sandbox_busy");
      await userEvent.keyboard("{Escape}");

      const retry = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
      binding.auth.runSandboxVerb.mockReturnValue(retry.promise);
      binding.auth.destroySandbox.mockReturnValue(retry.promise);
      await userEvent.click(
        within(line).getByRole("button", { name: "Retry" }),
      );
      expect((await within(row).findByRole("status")).textContent).toBe(
        testCase.pending,
      );
      expect(within(row).queryByRole("alert")).toBeNull();
      if (testCase.verb === "destroy") {
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          ["sbx-build", false],
          ["sbx-build", false],
        ]);
      } else {
        expect(
          binding.auth.runSandboxVerb.mock.calls.map(([id, verb]) => [
            id,
            verb,
          ]),
        ).toEqual([
          ["sbx-build", testCase.verb],
          ["sbx-build", testCase.verb],
        ]);
      }
      await act(async () => {
        retry.resolve({ kind: "ok", settled: true, state: testCase.reached });
        await retry.promise;
      });
      await waitFor(() => expect(within(row).queryByRole("status")).toBeNull());
      expect(within(row).queryByRole("alert")).toBeNull();
    },
  );
});
