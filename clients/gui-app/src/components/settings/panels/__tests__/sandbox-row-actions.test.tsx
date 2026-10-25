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
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
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
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({ useSandboxRepairGuestConfigurationOnHost: () => mutation() }),
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
  automation.openSandboxAutomation.mockReset();
  automation.getSandboxAutomation.mockReset();
  automation.close.mockClear();
  automation.navigate.mockReset();
  automation.activateTab.mockReset();
  automation.toastFromAuthError.mockReset();
  automation.navigate.mockReturnValue(new Promise<void>(() => undefined));
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  createMutate.mockClear();
  runStagedSandbox.mockClear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

function renderRowIn(client: QueryClient, element: ReactElement): void {
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
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
      { fallbackName: "build-box", taskId: null, resume: false },
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
      expect(useLandingPanelStore.getState().terminalRequest?.hostId).toBe(
        "host-automations",
      );
      expect(automation.close).toHaveBeenCalledTimes(1);
      expect(automation.activateTab).toHaveBeenCalledTimes(1);
      // The composer is left exactly as it was.
      expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
        "host-composer",
      );
      expect(readStagedSandbox(SURFACE)?.target.kind).toBe("new");
    }

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
      expectTerminalOnAutomationsHost();
    });
    it("files nothing and leaves Settings open when starting a released Automations fails", async () => {
      automation.openSandboxAutomation.mockResolvedValue(
        refusal(503, "provider_unavailable"),
      );
      renderAutomations(new QueryClient(), automationsRow("stopped", null), {
        kind: "personal",
      });

      await userEvent.click(screen.getByTestId("sandbox-row-open-terminal"));

      await waitFor(() => {
        expect(automation.toastFromAuthError).toHaveBeenCalledTimes(1);
      });
      expect(automation.toastFromAuthError.mock.calls[0][1]).toBe(
        "Couldn't start Automations. Retry it from Settings ▸ Sandboxes.",
      );
      expectNothingFiledOrClosed();
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

    it("files the request and closes Settings only once the start has succeeded", async () => {
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
      expectNothingFiledOrClosed();

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
