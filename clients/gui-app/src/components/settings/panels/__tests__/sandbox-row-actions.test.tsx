import { AutomationTerminalPane } from "@/components/home/terminal-panel/automation-terminal-pane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxCreateRequest,
  SandboxPod,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { useSandboxDetailsStore } from "@/stores/sandboxes/sandbox-details-store";
import { SandboxCreateError } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { terminalFocusOwnsInstance } from "@/lib/terminals/terminal-focus-registry";

const SURFACE = "landing:window-test";

const mutation = () => ({ mutate: vi.fn(), isPending: false });
const createMutate = vi.hoisted(() =>
  vi.fn<
    (
      variables: { readonly request: SandboxCreateRequest },
      callbacks: {
        readonly onSuccess: () => void;
        readonly onError: (error: Error) => void;
      },
    ) => void
  >(),
);

// The auth service is the network boundary of the Automations open and read.
const automation = vi.hoisted(() => ({
  openSandboxAutomation: vi.fn(),
  getSandboxAutomation: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  activateTab: vi.fn(),
  toastFromAuthError: vi.fn(),
  request: vi.fn(),
}));

const terminalClient = {
  getActiveHostId: () => "host-automations",
  getRequestContextUserId: () => "u1",
  request: automation.request,
  requestWithSignal: automation.request,
};
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => terminalClient,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null
      ? null
      : {
          hostId,
          kind: "local",
          transportDialability: "dialable",
          websocketUrl: "wss://host.test",
        },
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-composer",
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
  sandboxListReadSentAt: () => null,
}));

vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: automation.toastFromAuthError,
}));

// The tab strip is the router's side of the door the row opens.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: automation.activateTab,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => automation.navigate,
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => SURFACE,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => mutation(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-patch-mutation", () => ({
  useSandboxPatch: () => mutation(),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-create-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-create-mutation")
    >()),
    useSandboxCreate: () => ({ mutate: createMutate, isPending: false }),
  }),
);
type SettingsMutate = (variables: Record<string, never>) => void;
// The combined retry and the legacy guest-only repair are the network
// boundary; whether the host negotiated the combined retry is the gate.
const settings = vi.hoisted(() => ({
  retry: vi.fn<SettingsMutate>(),
  legacy: vi.fn<SettingsMutate>(),
  retrySupported: { value: false },
  legacySupported: { value: false },
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: () => ({
      mutate: settings.retry,
      isPending: false,
    }),
    useSandboxRepairGuestSetupOnHost: () => ({
      mutate: settings.legacy,
      isPending: false,
    }),
    useSandboxRetryApplyingSupported: () => settings.retrySupported.value,
    useSandboxGuestSetupRepairSupported: () => settings.legacySupported.value,
    useSandboxSettingsOperation: () => null,
  }),
);
// The run is the network boundary: it creates or wakes the sandbox.
const runStagedSandbox = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/sandboxes/staged-sandbox-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >()),
  runStagedSandbox,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    auth: automation,
    directory: { refresh: vi.fn() },
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
  useRunnerHostOrNull: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
// The confirm dialogs read the account; this suite never opens one.
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyDialog: () => null,
  SandboxIdleSettingsDialog: () => null,
  SandboxKeepDialog: () => null,
  SandboxRenameDialog: () => null,
  SandboxStopDialog: () => null,
  SandboxSuspendDialog: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: automation.close }),
}));

beforeEach(() => {
  resetNegotiatedManifests();
  recordNegotiatedHostMethods("host-automations", ["terminal.plain.create"]);
  automation.openSandboxAutomation.mockReset();
  automation.getSandboxAutomation.mockReset();
  automation.close.mockClear();
  automation.navigate.mockReset();
  automation.activateTab.mockReset();
  automation.toastFromAuthError.mockReset();
  automation.request.mockReset();
  automation.request.mockImplementation(
    (method: string, params: { terminalId: string; cwd: string }) => {
      if (method === "terminal.list") {
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            requestId: "legacy-list",
            method,
            message: "Unsupported",
            fatalDetails: null,
          }),
        );
      }
      if (method === "worktree.listBindingsForEpic")
        return Promise.resolve({ rows: [], folderlessCwd: "/automation/work" });
      if (method === "terminal.plain.list")
        return Promise.resolve({
          coverage: "complete-local",
          scope: { kind: "independent" },
          terminals: [],
        });
      if (method === "terminal.plain.create")
        return Promise.resolve({
          terminal: {
            record: {
              hostId: "host-automations",
              terminalId: params.terminalId,
              scope: { kind: "independent" },
              launch: { cwd: params.cwd },
              manualTitle: null,
              revision: 1,
              createdAt: "2026-10-27T00:00:00Z",
              updatedAt: "2026-10-27T00:00:00Z",
            },
            runtime: {
              status: "running",
              sessionId: params.terminalId,
              currentCwd: params.cwd,
              activeProcessName: "zsh",
              cols: 80,
              rows: 24,
            },
          },
        });
      return Promise.reject(new Error(`Unexpected RPC ${method}`));
    },
  );
  automation.navigate.mockReturnValue(new Promise<void>(() => undefined));
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  createMutate.mockClear();
  settings.retry.mockReset();
  settings.legacy.mockReset();
  settings.retrySupported.value = false;
  settings.legacySupported.value = false;
  runStagedSandbox.mockClear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLandingPanelStore.getState().resetForTests();
  useSandboxDetailsStore.setState({ sandboxId: null });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useSandboxDetailsStore.setState({ sandboxId: null });
});

function TerminalPaneHarness() {
  const placeholder = useLandingPanelStore((state) => state.placeholder);
  return placeholder?.automation === undefined ? null : (
    <AutomationTerminalPane
      request={placeholder.automation}
      instanceId={placeholder.instanceId}
    />
  );
}

function renderRowIn(client: QueryClient, element: ReactElement): void {
  render(
    <QueryClientProvider client={client}>
      {element}
      <TerminalPaneHarness />
    </QueryClientProvider>,
  );
}

function renderRow(element: ReactElement): void {
  renderRowIn(new QueryClient(), element);
}

describe("<SandboxRowActions />", () => {
  it("drops the landing composer's staged New sandbox when a row opens its own sandbox there", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "",
      wakeString: null,
    });
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "awake",
          burst: false,
          guestConfigured: true,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });

  it("stages a suspended sandbox to resume when a row opens it there, so the first send wakes it", async () => {
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          displayName: "build-box",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)?.target).toEqual({
      kind: "existing",
      hostId: "host-build",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });

  it.each([
    { item: "Open a tab", request: null },
    { item: "Open terminal", request: "host-build" },
  ])(
    "asks the landing panel for a terminal on an awake sandbox from $item: $request",
    async ({ item, request }) => {
      // An earlier press's ask that was never served; this one replaces it.
      useLandingPanelStore.getState().requestTerminal(SURFACE, "host-earlier");
      renderRow(
        <SandboxRowActions
          summary={sandboxSummaryFixture({
            id: "sbx-build",
            hostId: "host-build",
            state: "awake",
            burst: false,
            guestConfigured: true,
          })}
          configuration={{ kind: "personal" }}
          unreachable={false}
          frozenNeedsOwnCredits={false}
          settingsFailed={false}
        />,
      );

      await userEvent.click(
        screen.getByRole("button", { name: /^More actions for/ }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: item }),
      );

      expect(
        useLandingPanelStore.getState().terminalRequest?.hostId ?? null,
      ).toBe(request);
    },
  );

  it("wakes a suspended sandbox from Open terminal at once, marked to open its terminal and send nothing", async () => {
    useLandingPanelStore.getState().requestTerminal(SURFACE, "host-earlier");
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open terminal" }),
    );

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: { kind: "existing", hostId: "host-build", verb: "resume" },
      openTerminal: true,
      sendTaken: false,
    });
    expect(runStagedSandbox).toHaveBeenCalledTimes(1);
    expect(runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      true,
      { taskId: null, resume: false },
      expect.anything(),
    );
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });

  it("asks a send's wake of this sandbox on its way for the terminal too, keeping the send and starting no second wake", async () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, {
      kind: "existing",
      hostId: "host-build",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    store.begin(SURFACE, false, 1_000, false);
    store.report(SURFACE, { ownerId: "draft-1", sendTaken: true });
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open terminal" }),
    );

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "creating",
      ownerId: "draft-1",
      sendTaken: true,
      openTerminal: true,
    });
    expect(runStagedSandbox).not.toHaveBeenCalled();
  });

  it.each([
    { period: null, sent: 0 },
    { period: 4_320, sent: 4_320 },
  ])(
    "retries a failed create with its resting period ($period rests for $sent)",
    async ({ period, sent }) => {
      renderRow(
        <SandboxRowActions
          summary={sandboxSummaryFixture({
            state: "failed",
            destroyAfterRestingMinutes: period,
          })}
          configuration={{ kind: "personal" }}
          unreachable={false}
          frozenNeedsOwnCredits={false}
          settingsFailed={false}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(createMutate).toHaveBeenCalledTimes(1);
      expect(
        createMutate.mock.calls[0]?.[0].request.destroyAfterRestingMinutes,
      ).toBe(sent);
    },
  );

  it("keeps Retry's key until the server refuses it before creating, or accepts it", async () => {
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({ state: "failed" })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );
    const press = async (): Promise<{
      readonly key: string | null;
      readonly answer: {
        readonly onSuccess: () => void;
        readonly onError: (error: Error) => void;
      };
    }> => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      const call = createMutate.mock.calls.at(-1);
      if (call === undefined) throw new Error("expected a create");
      return { key: call[0].request.clientRequestId, answer: call[1] };
    };
    const refusal = (failure: SandboxControlFailure) =>
      new SandboxCreateError("no", null, null, failure);

    const first = await press();
    // The answer never came: the create may have been accepted.
    act(() =>
      first.answer.onError(
        refusal({ kind: "network-error", detail: "timeout" }),
      ),
    );
    const second = await press();
    expect(second.key).toBe(first.key);

    act(() =>
      second.answer.onError(
        refusal({
          kind: "refused",
          status: 402,
          code: "insufficient_credit",
          reason: null,
          shortfallMc: 100,
          newRateMcPerHour: null,
          currentAwakeBurnMcPerHour: null,
          message: null,
        }),
      ),
    );
    const third = await press();
    expect(third.key).not.toBe(second.key);

    act(() => third.answer.onSuccess());
    const fourth = await press();
    expect(fourth.key).not.toBe(third.key);
  });

  describe("an Automations row", () => {
    const TEAM_POD_ID = "sbx-pod";
    const TEAM = {
      kind: "team",
      teamId: "team-1",
      teamName: "Acme",
      environmentId: "env-acme",
    } as const;

    function automationsRow(
      state: "awake" | "stopped" | "suspended" | "failed",
      environmentId: string | null,
    ): SandboxSummary {
      return sandboxSummaryFixture({
        id: TEAM_POD_ID,
        hostId: "host-automations",
        displayName: "Automations",
        kind: "automation",
        environmentId,
        state,
        burst: false,
        frozen: false,
      });
    }

    function stageNewSandbox(): void {
      useStagedSandboxStore.getState().stage(SURFACE, {
        kind: "new",
        configuration: { kind: "personal" },
        shape: {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: 10_080,
        },
        name: "",
        wakeString: null,
      });
    }

    /** The team's pod list as the page reads it, the pod at `ordinal`. */
    function answerPods(ordinal: number): void {
      automation.getSandboxAutomation.mockResolvedValue({
        kind: "ok",
        automation: {
          available: true,
          sandbox: null,
          pods: [
            {
              sandbox: automationsRow("suspended", "env-acme"),
              ordinal,
              liveShells: 0,
              headroom: 1,
            },
          ],
        },
      });
    }

    function renderAutomations(
      client: QueryClient,
      summary: SandboxSummary,
      configuration: React.ComponentProps<
        typeof SandboxRowActions
      >["configuration"],
    ): void {
      renderRowIn(
        client,
        <SandboxRowActions
          summary={summary}
          configuration={configuration}
          unreachable={false}
          frozenNeedsOwnCredits={false}
          settingsFailed={false}
        />,
      );
    }

    /** The composer is on another host with a New sandbox staged: Automations never moves it. */
    beforeEach(() => {
      stageNewSandbox();
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(SURFACE, "host-composer");
    });

    function expectNothingFiledOrClosed(): void {
      expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
      expect(automation.close).not.toHaveBeenCalled();
      expect(automation.activateTab).not.toHaveBeenCalled();
    }

    function expectTerminalOnAutomationsHost(): void {
      expect(useLandingPanelStore.getState().tabs).toEqual([
        expect.objectContaining({
          kind: "terminal",
          hostId: "host-automations",
          cwd: "/automation/work",
        }),
      ]);
      expect(automation.close).toHaveBeenCalledTimes(1);
      expect(automation.activateTab).toHaveBeenCalledTimes(1);
      // The composer is left exactly as it was.
      expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
        "host-composer",
      );
      expect(readStagedSandbox(SURFACE)?.target.kind).toBe("new");
    }

    it("creates and reveals a requested Automations terminal when legacy terminal.list is unsupported", async () => {
      renderAutomations(
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        automationsRow("awake", null),
        { kind: "personal" },
      );
      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await waitFor(() =>
        expect(useLandingPanelStore.getState().tabs).toHaveLength(1),
      );
      const state = useLandingPanelStore.getState();
      const tab = state.tabs[0];
      expect(tab).toMatchObject({
        kind: "terminal",
        hostId: "host-automations",
        cwd: "/automation/work",
        pendingCreate: false,
        hostAuthorityAcknowledged: true,
      });
      expect(automation.request).toHaveBeenCalledWith(
        "terminal.plain.create",
        expect.objectContaining({
          terminalId: tab.sessionId,
          cwd: "/automation/work",
          scope: { kind: "independent" },
        }),
      );
      expect(
        automation.request.mock.calls.some(
          ([method]) => method === "terminal.list",
        ),
      ).toBe(false);
      expect(state.activeInstanceId).toBe(tab.instanceId);
      expect(state.panelReveal).toBe(tab.instanceId);
      expect(terminalFocusOwnsInstance(tab.instanceId)).toBe(true);
      expect(automation.close).toHaveBeenCalledTimes(1);
    });

    it("keeps an explicit Retry in the terminal pane when the Automations terminal list fails", async () => {
      const success = automation.request.getMockImplementation();
      automation.request.mockImplementation(
        (method: string, ...params: unknown[]): unknown =>
          method === "terminal.plain.list"
            ? Promise.reject(new Error("List failed"))
            : success?.(method, ...params),
      );
      renderAutomations(
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        automationsRow("awake", null),
        { kind: "personal" },
      );
      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await screen.findByText("Couldn't open a terminal on Automations.");
      expect(automation.close).toHaveBeenCalledTimes(1);
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
      if (success !== undefined) automation.request.mockImplementation(success);
      await userEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
      await waitFor(() =>
        expect(useLandingPanelStore.getState().tabs).toHaveLength(1),
      );
      expect(automation.close).toHaveBeenCalledTimes(1);
    });

    it("offers Open terminal, and Rename and Details in its menu, with no Destroy or Stop", async () => {
      renderAutomations(new QueryClient(), automationsRow("awake", null), {
        kind: "personal",
      });

      expect(screen.getByTestId("sandbox-row-open-terminal").textContent).toBe(
        "Open terminal",
      );
      await userEvent.click(
        screen.getByRole("button", { name: /^More actions for/ }),
      );
      const menu = await screen.findByTestId("sandbox-row-menu-content");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Rename", "Details"]);
    });

    it("starts Personal's released Automations with no body, then asks for a terminal on it", async () => {
      automation.openSandboxAutomation.mockResolvedValue({
        kind: "ok",
        sandbox: automationsRow("awake", null),
        settled: false,
      });
      renderAutomations(new QueryClient(), automationsRow("stopped", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await waitFor(() => {
        expect(automation.openSandboxAutomation).toHaveBeenCalledWith(null);
      });
      expect(automation.openSandboxAutomation).toHaveBeenCalledTimes(1);
      await waitFor(expectTerminalOnAutomationsHost);
    });

    it("starts a released team pod by its environment and the ordinal its pod list names", async () => {
      automation.openSandboxAutomation.mockResolvedValue({
        kind: "ok",
        sandbox: automationsRow("awake", "env-acme"),
        settled: true,
      });
      answerPods(2);
      const client = new QueryClient();
      renderAutomations(client, automationsRow("suspended", "env-acme"), TEAM);
      await waitFor(() => {
        expect(automation.getSandboxAutomation).toHaveBeenCalledWith(
          "env-acme",
        );
      });
      await waitFor(() => {
        expect(client.isFetching()).toBe(0);
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await waitFor(() => {
        expect(automation.openSandboxAutomation).toHaveBeenCalledWith({
          environmentId: "env-acme",
          ordinal: 2,
        });
      });
      await waitFor(expectTerminalOnAutomationsHost);
    });

    it("asks for the terminal on a running Automations host without starting anything", async () => {
      renderAutomations(new QueryClient(), automationsRow("awake", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      expect(automation.openSandboxAutomation).not.toHaveBeenCalled();
      await waitFor(expectTerminalOnAutomationsHost);
    });
    it("keeps the terminal pane when starting a released Automations fails", async () => {
      automation.openSandboxAutomation.mockResolvedValue(
        refusal(503, "provider_unavailable"),
      );
      renderAutomations(new QueryClient(), automationsRow("stopped", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await screen.findByText("Couldn't open a terminal on Automations.");
      expect(automation.toastFromAuthError).not.toHaveBeenCalled();
      expect(automation.close).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("automation-terminal-pane")).toBeTruthy();
    });

    it("offers a failed row Retry, and Rename and Details in its menu", async () => {
      renderAutomations(new QueryClient(), automationsRow("failed", null), {
        kind: "personal",
      });

      expect(screen.getByTestId("sandbox-row-retry").textContent).toBe("Retry");
      expect(screen.queryByTestId("sandbox-row-open-terminal")).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: /^More actions for/ }),
      );
      const menu = await screen.findByTestId("sandbox-row-menu-content");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Rename", "Details"]);
    });

    it("retries a failed row by starting Automations again, and opens no terminal", async () => {
      automation.openSandboxAutomation.mockResolvedValue({
        kind: "ok",
        sandbox: automationsRow("awake", null),
        settled: true,
      });
      renderAutomations(new QueryClient(), automationsRow("failed", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-retry"));

      await waitFor(() => {
        expect(automation.openSandboxAutomation).toHaveBeenCalledWith(null);
      });
      expect(automation.openSandboxAutomation).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(automation.openSandboxAutomation).toHaveResolved();
      });
      expectNothingFiledOrClosed();
    });

    describe("a failed team pod's Retry reads the pod list first", () => {
      /** Ordinal 2 is the clicked row's pod; any other is a different sandbox on its own host. */
      function podAt(ordinal: number): SandboxPod {
        const clicked = automationsRow("failed", "env-acme");
        return {
          sandbox:
            ordinal === 2
              ? clicked
              : {
                  ...clicked,
                  id: `sbx-pod-${ordinal}`,
                  hostId: `host-pod-${ordinal}`,
                },
          ordinal,
          liveShells: 0,
          headroom: 1,
        };
      }

      function answerWith(pods: readonly SandboxPod[]) {
        return {
          kind: "ok",
          automation: { available: true, sandbox: null, pods },
        };
      }

      function renderFailedPod(): QueryClient {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        renderAutomations(client, automationsRow("failed", "env-acme"), TEAM);
        return client;
      }

      beforeEach(() => {
        automation.openSandboxAutomation.mockResolvedValue({
          kind: "ok",
          sandbox: automationsRow("awake", "env-acme"),
          settled: true,
        });
      });

      it("stays pending through a cold lookup, then wakes the clicked ordinal once and opens no terminal", async () => {
        let answer: (result: unknown) => void = () => undefined;
        automation.getSandboxAutomation.mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        renderFailedPod();
        await waitFor(() => {
          expect(automation.getSandboxAutomation).toHaveBeenCalledWith(
            "env-acme",
          );
        });

        await userEvent.click(screen.getByTestId("sandbox-row-retry"));
        await userEvent.click(screen.getByTestId("sandbox-row-retry"));
        expect(automation.openSandboxAutomation).not.toHaveBeenCalled();
        expect(
          screen.getByTestId<HTMLButtonElement>("sandbox-row-retry").disabled,
        ).toBe(true);

        answer(answerWith([podAt(2)]));
        await waitFor(() => {
          expect(automation.openSandboxAutomation).toHaveBeenCalledTimes(1);
        });
        expect(automation.openSandboxAutomation).toHaveBeenCalledWith({
          environmentId: "env-acme",
          ordinal: 2,
        });
        await waitFor(() => {
          expect(automation.openSandboxAutomation).toHaveResolved();
        });
        expectNothingFiledOrClosed();
      });

      it("shows a failed lookup on the row without waking, and Retry refetches then wakes the exact pod", async () => {
        let answer: (result: unknown) => void = () => undefined;
        automation.getSandboxAutomation.mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        renderFailedPod();
        await waitFor(() => {
          expect(automation.getSandboxAutomation).toHaveBeenCalledTimes(1);
        });

        await userEvent.click(screen.getByTestId("sandbox-row-retry"));
        answer({ kind: "network-error", detail: "offline" });
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain(
          "Couldn't look up this host. Try again.",
        );
        expect(automation.openSandboxAutomation).not.toHaveBeenCalled();

        automation.getSandboxAutomation.mockImplementation(() =>
          Promise.resolve(answerWith([podAt(1), podAt(2)])),
        );
        await userEvent.click(screen.getByTestId("sandbox-row-retry"));

        await waitFor(() => {
          expect(automation.openSandboxAutomation).toHaveBeenCalledTimes(1);
        });
        // The Retry asked for a fresh lookup before it woke; the wake's own
        // refresh may read once more.
        expect(
          automation.getSandboxAutomation.mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
        expect(automation.openSandboxAutomation).toHaveBeenCalledWith({
          environmentId: "env-acme",
          ordinal: 2,
        });
        expectNothingFiledOrClosed();
      });

      it("says the host is gone when the settled list lacks the pod, and wakes nothing", async () => {
        const row = automationsRow("failed", "env-acme");
        let answer: (result: unknown) => void = () => undefined;
        automation.getSandboxAutomation.mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        renderFailedPod();
        await waitFor(() => {
          expect(automation.getSandboxAutomation).toHaveBeenCalledTimes(1);
        });

        await userEvent.click(screen.getByTestId("sandbox-row-retry"));
        answer(
          answerWith([{ ...podAt(1), sandbox: { ...row, id: "sbx-other" } }]),
        );

        expect(
          await screen.findByText("This host no longer exists."),
        ).toBeTruthy();
        expect(automation.openSandboxAutomation).not.toHaveBeenCalled();
        expectNothingFiledOrClosed();
      });

      it("wakes nothing when the account changes before the cold lookup answers, and shows the new account no old state", async () => {
        const answers: Array<(result: unknown) => void> = [];
        automation.getSandboxAutomation.mockImplementation(
          () =>
            new Promise((resolve) => {
              answers.push(resolve);
            }),
        );
        const client = renderFailedPod();
        await waitFor(() => {
          expect(automation.getSandboxAutomation).toHaveBeenCalledTimes(1);
        });
        await userEvent.click(screen.getByTestId("sandbox-row-retry"));

        act(() => {
          useAuthStore.setState({
            status: "signed-in",
            contextMetadata: { userId: "u2", username: "grace" },
          });
        });
        await waitFor(() => {
          expect(automation.getSandboxAutomation).toHaveBeenCalledTimes(2);
        });
        for (const answer of answers) answer(answerWith([podAt(2)]));
        await waitFor(() => {
          expect(client.isFetching()).toBe(0);
        });

        expect(automation.openSandboxAutomation).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          screen.getByTestId<HTMLButtonElement>("sandbox-row-retry").disabled,
        ).toBe(false);
        expectNothingFiledOrClosed();
      });
    });

    it("closes Settings onto the reserved pane while the start is still pending", async () => {
      let finishStart: (result: {
        kind: "ok";
        sandbox: SandboxSummary;
        settled: boolean;
      }) => void = () => undefined;
      automation.openSandboxAutomation.mockReturnValue(
        new Promise((resolve) => {
          finishStart = resolve;
        }),
      );
      renderAutomations(new QueryClient(), automationsRow("stopped", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));
      await waitFor(() => {
        expect(automation.openSandboxAutomation).toHaveBeenCalledTimes(1);
      });
      expect(automation.close).toHaveBeenCalledTimes(1);
      expect(
        useLandingPanelStore.getState().placeholder?.automation?.existing
          ?.hostId,
      ).toBe("host-automations");

      await act(async () => {
        finishStart({
          kind: "ok",
          sandbox: automationsRow("awake", null),
          settled: true,
        });
        await Promise.resolve();
      });

      await waitFor(expectTerminalOnAutomationsHost);
    });
  });

  it("still pins the composer to a running agent sandbox's host from its Open terminal", async () => {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(SURFACE, "host-composer");
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "awake",
          burst: false,
          guestConfigured: true,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open terminal" }),
    );

    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });
});

describe("<SandboxRowActions /> a sandbox whose settings did not apply", () => {
  const REPAIR_METHOD = "host.sandbox.repairGuestConfiguration";
  function renderFailed(
    overrides: Partial<SandboxSummary>,
    settingsFailed: boolean,
  ): void {
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-failed",
          hostId: "host-failed",
          burst: false,
          guestConfigured: false,
          ...overrides,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={settingsFailed}
      />,
    );
  }

  async function menuItems(): Promise<readonly string[]> {
    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    const menu = await screen.findByTestId("sandbox-row-menu-content");
    return within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
  }

  describe("on a host that negotiated the combined retry", () => {
    beforeEach(() => {
      settings.retrySupported.value = true;
      recordNegotiatedHostMethods("host-failed", [REPAIR_METHOD]);
    });

    it("offers Retry applying with the awake sandbox's own Open terminal, Stop, Choose another host and Details", () => {
      renderFailed({ state: "awake" }, false);

      expect(
        screen.getByRole("button", { name: "Retry applying" }),
      ).toBeTruthy();
      for (const name of [
        "Open terminal",
        "Stop",
        "Choose another host",
        "Details",
      ]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });

    it("offers Retry applying for an environment-only failure whose guest is fine", () => {
      renderFailed({ state: "awake", guestConfigured: true }, true);

      expect(
        screen.getByRole("button", { name: "Retry applying" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });

    it.each([
      { guestConfigured: false, settingsFailed: false },
      { guestConfigured: true, settingsFailed: true },
    ])(
      "keeps Details only inline and keeps the lifecycle menu for guestConfigured=$guestConfigured, settingsFailed=$settingsFailed",
      async ({ guestConfigured, settingsFailed }) => {
        renderFailed({ state: "awake", guestConfigured }, settingsFailed);
        const details = screen.getByRole("button", { name: "Details" });

        expect(await menuItems()).toEqual([
          "Open terminal",
          "Rename",
          "Stop",
          "Destroy",
        ]);
        await userEvent.keyboard("{Escape}");
        await userEvent.click(details);
        expect(useSandboxDetailsStore.getState().sandboxId).toBe("sbx-failed");
      },
    );

    it("retries with the combined retry, never the guest-only repair", async () => {
      renderFailed({ state: "awake" }, false);

      await userEvent.click(
        screen.getByRole("button", { name: "Retry applying" }),
      );

      expect(settings.retry).toHaveBeenCalledTimes(1);
      expect(settings.retry.mock.calls[0][0]).toEqual({});
      expect(settings.legacy).not.toHaveBeenCalled();
    });
  });

  describe("on a host without the combined retry", () => {
    beforeEach(() => {
      settings.retrySupported.value = false;
      settings.legacySupported.value = true;
      recordNegotiatedHostMethods("host-failed", [REPAIR_METHOD]);
    });

    it("offers Repair setup, never Retry applying, for a guest that really failed", () => {
      renderFailed({ state: "awake" }, false);

      expect(screen.getByRole("button", { name: "Repair setup" })).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("runs the guest-only repair, never the combined retry", async () => {
      renderFailed({ state: "awake" }, false);

      await userEvent.click(
        screen.getByRole("button", { name: "Repair setup" }),
      );

      expect(settings.retry).not.toHaveBeenCalled();
      expect(settings.legacy).toHaveBeenCalledTimes(1);
      expect(settings.legacy.mock.calls[0][0]).toEqual({});
    });

    it("offers no guest repair for an environment-only failure whose guest is fine", () => {
      renderFailed({ state: "awake", guestConfigured: true }, true);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("offers no guest repair while the guest fact is unknown", () => {
      renderFailed({ state: "awake", guestConfigured: null }, true);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("offers no repair when the repair method is present but its version is not known to be 1.0", () => {
      settings.legacySupported.value = false;
      recordNegotiatedHostMethods("host-failed", [REPAIR_METHOD]);
      renderFailed({ state: "awake" }, false);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("offers no repair when the host has no repair method at all", () => {
      settings.legacySupported.value = false;
      recordNegotiatedHostMethods("host-failed", ["terminal.plain.create"]);
      renderFailed({ state: "awake" }, false);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });
  });

  describe("keeps the lifecycle's own actions", () => {
    beforeEach(() => {
      settings.retrySupported.value = true;
      recordNegotiatedHostMethods("host-failed", [REPAIR_METHOD]);
    });

    it("starts a stopped sandbox and cannot stop or open a terminal on it", async () => {
      renderFailed({ state: "stopped" }, false);

      expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Open terminal" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
      const items = await menuItems();
      expect(items).not.toContain("Stop");
      expect(items).toContain("Destroy");
    });

    it("offers neither Stop nor Open terminal on a sandbox being destroyed", () => {
      renderFailed({ state: "destroying" }, false);

      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Open terminal" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("still resumes a suspended sandbox", async () => {
      renderFailed({ state: "suspended" }, false);

      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(await menuItems()).toContain("Destroy");
    });

    it("still offers Give it another period on a stopped sandbox near its destroy time", () => {
      renderFailed(
        {
          state: "stopped",
          destroyAfterRestingMinutes: 60,
          destroyAt: Date.now() + 1_000,
        },
        false,
      );

      expect(screen.getByTestId("sandbox-row-give-another")).toBeTruthy();
    });
  });

  describe("on a sandbox whose settings applied", () => {
    it("keeps the full awake menu and Suspend", async () => {
      renderFailed({ state: "awake", guestConfigured: true }, false);

      expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
      expect(await menuItems()).toEqual([
        "Open a tab",
        "Open terminal",
        "Rename",
        "Idle settings…",
        "Stop",
        "Details",
        "Destroy",
      ]);
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("keeps Stop as the primary of an unreachable awake sandbox", () => {
      renderRow(
        <SandboxRowActions
          summary={sandboxSummaryFixture({
            id: "sbx-unreachable",
            hostId: "host-failed",
            state: "awake",
            burst: false,
            guestConfigured: true,
          })}
          configuration={{ kind: "personal" }}
          unreachable
          frozenNeedsOwnCredits={false}
          settingsFailed={false}
        />,
      );

      expect(screen.getByTestId("sandbox-row-stop")).toBeTruthy();
    });
  });
});
