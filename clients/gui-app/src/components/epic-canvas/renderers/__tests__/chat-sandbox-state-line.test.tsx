import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import {
  SandboxSetupLine,
  type SandboxSetupLineActions,
} from "@/components/composer/sandbox-setup-line";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import { StrictMode } from "react";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { chatSandboxStateLine } from "@/components/epic-canvas/renderers/chat-sandbox-state-line";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { resolveChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxDetailsStore } from "@/stores/sandboxes/sandbox-details-store";
import { useEndedSandboxHostsStore } from "@/stores/sandboxes/ended-sandbox-hosts-store";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  configurations: [] as SandboxPageConfiguration[],
  environments: undefined as EnvironmentListResponseV11 | undefined,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
  useRunnerHostOrNull: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
// The stop dialog's session list reads the Needs-you feed and tile opening;
// neither is under test here.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));
vi.mock("@/lib/notifications", () => ({
  routeNotificationForHost: () => false,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: mocks.environments }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: mocks.configurations,
      teamEnvironmentIds: new Set<string>(),
      complete: false,
    }),
  }),
);

const TEAM: SandboxPageConfiguration = {
  kind: "team",
  teamId: "team-acme",
  teamName: "Acme",
  environmentId: "env-acme",
};
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  mocks.binding = createFakeSandboxBinding();
  mocks.configurations = [{ kind: "personal" }, TEAM];
  mocks.environments = undefined;
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "test-user", username: "test-member" },
  });
  useSandboxDetailsStore.setState({ sandboxId: null });
  useSandboxWakeReportStore.setState({ setupStops: {} });
});

afterEach(() => {
  cleanup();
  client.clear();
  mocks.binding = null;
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useSandboxDetailsStore.setState({ sandboxId: null });
  useEndedSandboxHostsStore.setState({ byHostId: {} });
});

function FailedChatLine(props: { readonly summary: SandboxSummary }) {
  const view = resolveChatSandbox(
    { kind: "failed", sandbox: props.summary },
    {
      reachable: false,
      canEdit: true,
      ownedByViewer: true,
      environmentOwned: true,
    },
  );
  const line = chatSandboxStateLine(view.line, null);
  return (
    <div>
      {line?.line}
      {line?.actions}
    </div>
  );
}

function mount(summary: SandboxSummary) {
  return render(
    <QueryClientProvider client={client}>
      <FailedChatLine summary={summary} />
    </QueryClientProvider>,
  );
}

async function openMenu(): Promise<HTMLElement> {
  await userEvent.click(
    screen.getByRole("button", { name: /^More actions for/ }),
  );
  return screen.findByRole("menu");
}

describe("a failed sandbox's chat actions", () => {
  it("allows a personal environment id only after the environment list identifies it as Personal", async () => {
    const summary = sandboxSummaryFixture({
      state: "failed",
      environmentId: "env-personal",
    });
    const binding = mocks.binding;
    if (binding === null) throw new Error("expected the signed-in binding");
    const mounted = mount(summary);
    expect(
      screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(true);

    mocks.environments = {
      environments: [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "test-user",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 1,
          providerHandle: "personal-handle",
        },
      ],
    };
    mounted.rerender(
      <QueryClientProvider client={client}>
        <FailedChatLine summary={summary} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(binding.auth.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: "env-personal" }),
      ),
    );
  });

  it.each([null, { userId: "another-member", displayName: "Dana" }])(
    "holds Retry until the sandbox's own team resolves (creator %j)",
    async (createdBy) => {
      const summary = sandboxSummaryFixture({
        state: "failed",
        environmentId: "env-acme",
        createdBy,
      });
      const binding = mocks.binding;
      if (binding === null) throw new Error("expected the signed-in binding");
      const accepted = sandboxSummaryFixture({ state: "creating" });
      binding.auth.createSandbox.mockResolvedValue({
        kind: "ok",
        accepted: {
          sandboxId: accepted.id,
          hostId: accepted.hostId,
          sandbox: accepted,
        },
      });
      mocks.configurations = [
        { kind: "personal" },
        { ...TEAM, environmentId: "env-other" },
      ];
      mocks.environments = {
        environments: [
          {
            environmentId: "env-acme",
            ownerKind: "organization",
            ownerId: "team-acme",
            roomId: "room-acme",
            label: "Acme",
            effectiveRole: "admin",
            kind: "team",
            hostCount: 1,
            providerHandle: "acme-handle",
          },
        ],
      };
      const mounted = mount(summary);
      expect(
        screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
      ).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(binding.auth.createSandbox).not.toHaveBeenCalled();

      const menu = await openMenu();
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Details", "Destroy"]);
      await userEvent.keyboard("{Escape}");
      mocks.configurations = [{ kind: "personal" }, TEAM];
      mounted.rerender(
        <QueryClientProvider client={client}>
          <FailedChatLine summary={summary} />
        </QueryClientProvider>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() =>
        expect(binding.auth.createSandbox).toHaveBeenCalledTimes(1),
      );
      expect(binding.auth.createSandbox.mock.calls[0]?.[0]).toMatchObject({
        os: summary.os,
        cpus: summary.cpus,
        memoryMb: summary.memoryMb,
        diskMb: summary.diskMb,
        region: summary.region,
        displayName: summary.displayName,
        idleMinutes: summary.idleMinutes,
        burst: false,
        createdByHostId: null,
        createdByAgentId: null,
        environmentId: "env-acme",
        destroyAfterRestingMinutes: 0,
        createdByTaskId: null,
      });
    },
  );

  it("keeps burst Retry suppressed while Details and confirmed Destroy act on this sandbox", async () => {
    const summary = sandboxSummaryFixture({ state: "failed", burst: true });
    const binding = mocks.binding;
    if (binding === null) throw new Error("expected the signed-in binding");
    mount(summary);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    let menu = await openMenu();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Details" }),
    );
    expect(useSandboxDetailsStore.getState().sandboxId).toBe(summary.id);

    menu = await openMenu();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Destroy" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Destroy build-box?",
    });
    expect(binding.auth.destroySandbox).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Type the name to confirm" }),
      summary.displayName,
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Destroy" }),
    );
    await waitFor(() =>
      expect(binding.auth.destroySandbox).toHaveBeenCalledWith(
        summary.id,
        false,
      ),
    );
    expect(binding.auth.createSandbox).not.toHaveBeenCalled();
  });
});

function MovingChatLine(props: {
  readonly summary: SandboxSummary;
  readonly state: "resuming" | "starting";
}) {
  const view = resolveChatSandbox(
    { kind: "moving", sandbox: props.summary, state: props.state },
    {
      reachable: false,
      canEdit: true,
      ownedByViewer: true,
      environmentOwned: true,
    },
  );
  const line = chatSandboxStateLine(view.line, null);
  return (
    <div>
      {line?.line}
      {line?.actions}
    </div>
  );
}

describe("a moving sandbox's chat actions", () => {
  function mountMoving(
    summary: SandboxSummary,
    state: "resuming" | "starting",
  ) {
    return render(
      <QueryClientProvider client={client}>
        <MovingChatLine summary={summary} state={state} />
      </QueryClientProvider>,
    );
  }

  it("offers Stop on the pending line of an awake row, and the stop dialog runs the stop", async () => {
    const summary = sandboxSummaryFixture({ state: "awake" });
    const binding = mocks.binding;
    if (binding === null) throw new Error("expected the signed-in binding");
    mountMoving(summary, "resuming");
    expect(screen.getByText("Resuming build-box · pending")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = await screen.findByTestId("sandbox-confirm-stop");
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByTestId("sandbox-confirm-stop-action"),
    );

    await waitFor(() => expect(binding.auth.runSandboxVerb).toHaveBeenCalled());
    expect(binding.auth.runSandboxVerb.mock.calls[0]?.slice(0, 2)).toEqual([
      summary.id,
      "stop",
    ]);
  });

  it("offers no Stop on the same line while the row is still resuming", () => {
    mountMoving(sandboxSummaryFixture({ state: "resuming" }), "resuming");

    expect(screen.getByText("Resuming build-box · pending")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("only one Stop on screen", () => {
  const ACTIONS: SandboxSetupLineActions = {
    onKeepWaiting: vi.fn(),
    onCancel: vi.fn(),
    onChooseAnotherHost: null,
    chooseAnotherHostLabel: "Use This computer",
    onRetryCreation: vi.fn(),
    onRetry: vi.fn(),
    onSendAgain: vi.fn(),
    onChangeShape: null,
    onRetryApplying: null,
    onRepairSetup: null,
    onStop: vi.fn(),
    onOpenTerminal: null,
  };

  function heldSend(sandboxId: string): StagedSandbox {
    const now = Date.now();
    return {
      target: {
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
        name: "build-box",
        wakeString: null,
      },
      phase: "creating",
      clientRequestId: "req-1",
      ownerId: null,
      createdSandboxId: sandboxId,
      createdHostId: "host-sbx-1",
      startedAt: now,
      step: "creating",
      stepAt: now,
      failure: null,
      terminalLaunch: null,
      openTerminal: false,
      sendTaken: true,
    };
  }

  function SetupAndStateLines(props: {
    readonly summary: SandboxSummary;
    readonly withdrawalAllowed: boolean;
    /** Which kept-mounted layer hides the setup line, if any. */
    readonly concealed: "none" | "tab" | "pane";
  }) {
    return (
      <QueryClientProvider client={client}>
        <TabBodySelectedContext value={props.concealed !== "tab"}>
          <PaneVisibilityContext value={props.concealed !== "pane"}>
            <div hidden={props.concealed !== "none"}>
              <SandboxSetupLine
                stage={heldSend(props.summary.id)}
                name="build-box"
                facts={{
                  costLine: "",
                  regionLabel: "US East",
                  shapeLabel: "2 vCPU · 4 GB",
                  smallerShapeAffordable: false,
                  offeredAgents: null,
                  sandboxAwake: true,
                  sandboxStoppable: true,
                  sandboxResting: false,
                }}
                actions={ACTIONS}
                withdrawalAllowed={props.withdrawalAllowed}
              />
            </div>
          </PaneVisibilityContext>
        </TabBodySelectedContext>
        <MovingChatLine summary={props.summary} state="resuming" />
      </QueryClientProvider>
    );
  }

  it("shows the setup line's Stop alone, then the pending line's when the setup line drops its own", () => {
    const summary = sandboxSummaryFixture({ state: "awake" });
    const view = render(
      <SetupAndStateLines
        summary={summary}
        withdrawalAllowed
        concealed="none"
      />,
    );
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(screen.getByTestId("sandbox-setup-stop")).toBeTruthy();

    // A send that can no longer be withdrawn drops the setup line's Stop.
    view.rerender(
      <SetupAndStateLines
        summary={summary}
        withdrawalAllowed={false}
        concealed="none"
      />,
    );

    expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
  });

  it.each(["tab", "pane"] as const)(
    "restores the pending line's Stop when the setup line sits in a concealed %s",
    (concealed) => {
      const summary = sandboxSummaryFixture({ state: "awake" });
      useSandboxWakeReportStore.setState({ setupStops: {} });
      const view = render(
        <SetupAndStateLines
          summary={summary}
          withdrawalAllowed
          concealed="none"
        />,
      );
      expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
      expect(screen.getByTestId("sandbox-setup-stop")).toBeTruthy();

      view.rerender(
        <SetupAndStateLines
          summary={summary}
          withdrawalAllowed
          concealed={concealed}
        />,
      );

      // The concealed line's Stop is off screen, so the pending line offers one.
      expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Stop" }).dataset.testid,
      ).not.toBe("sandbox-setup-stop");
    },
  );

  it("releases the setup line's claim after a StrictMode mount and unmount", () => {
    const summary = sandboxSummaryFixture({ state: "awake" });
    useSandboxWakeReportStore.setState({ setupStops: {} });
    const first = render(
      <StrictMode>
        <SetupAndStateLines
          summary={summary}
          withdrawalAllowed
          concealed="none"
        />
      </StrictMode>,
    );
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);

    first.unmount();
    render(
      <QueryClientProvider client={client}>
        <MovingChatLine summary={summary} state="resuming" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
