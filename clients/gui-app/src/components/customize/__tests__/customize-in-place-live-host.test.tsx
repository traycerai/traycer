import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as modelPickerRegistry from "@/lib/commands/active-model-picker-registry";
import { getActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import * as controlsRegistry from "@/lib/commands/composer-controls-registry";
import { getFocusedComposerControls } from "@/lib/commands/composer-controls-registry";
import { exitCustomize } from "@/lib/customize/enter-exit";
import { undo } from "@/lib/customize/history";
import { registerComposerToolbarCustomizeOptions } from "@/lib/customize/options/composer-toolbar-options";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full in-place session over the LIVE composer toolbar, with the real
 * `CustomizeOverlay`, real proxies and real popover.
 *
 * External boundary, and the only thing faked: a real `HostClient` over a
 * `MockHostMessenger` (same construction as
 * `home/__tests__/harness-model-picker-intent-rpc.test.tsx`). Every request
 * the toolbar makes lands in `messenger.calls`, whatever its method, so the
 * count is a real delta rather than a hand-listed set of handlers.
 *
 * The toolbar's own live queries (harness catalog, models) are ALLOWED and
 * appear in the baseline; the metric is what the EDITOR adds on top of them,
 * on the SAME mounted nodes, across: enter, open the model form, change it,
 * open the mic form, change it, Undo twice, exit.
 */

vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: vi.fn(),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: [] },
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  useProvidersListForClient: () => ({
    data: { providers: [] },
    isPending: false,
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "local",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
        label: "Local host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));

// Every accessor a live piece can reach the host through resolves to the one
// fixture client (same seams `harness-model-picker-intent-rpc.test.tsx` and the
// wave-4 studio suite use).
const hostBindingMock = vi.hoisted<{
  current: { readonly hostClient: unknown } | null;
}>(() => ({ current: null }));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => hostBindingMock.current?.hostClient,
  useOptionalHostClient: () => hostBindingMock.current?.hostClient ?? null,
  useHostRuntimeClient: () => hostBindingMock.current?.hostClient,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? (hostBindingMock.current?.hostClient ?? null) : hostId,
}));

registerComposerToolbarCustomizeOptions();

function createRecordingHost() {
  const queryClient = createAppQueryClient();
  let requestCounter = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestCounter += 1;
      return `req-${String(requestCounter)}`;
    },
    handlers: {
      "agent.gui.listHarnesses": () => ({
        harnesses: [
          {
            id: "claude",
            label: "claude",
            enabled: true,
            available: true,
            error: null,
            modes: ["gui", "tui"],
            requiresApiKey: false,
            supportedPermissionModes: [],
            nativeAutoJudge: false,
            availabilityPending: false,
          },
        ],
      }),
      "agent.gui.listModels": (params) => ({
        harnessId: params.harnessId,
        models: [],
      }),
      "agent.gui.listCommands": (params) => ({
        harnessId: params.harnessId,
        commands: [],
      }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostBindingMock.current = {
    hostClient: spine.createRequester(mockLocalHostEntry),
  };
  return { queryClient, messenger };
}

function toolbarStore() {
  return createComposerToolbarStore({
    seedKey: "customize-in-place-live-host-test",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

function requireProxy(settingId: string): HTMLButtonElement {
  const proxy = proxyFor(settingId);
  if (proxy === null) throw new Error(`no proxy for ${settingId}`);
  return proxy;
}

function proxyFor(settingId: string): HTMLButtonElement | null {
  const key = [...useCustomizeStore.getState().instances.keys()].find(
    (candidate) => candidate.startsWith(`${settingId}@`),
  );
  return key === undefined
    ? null
    : document.querySelector<HTMLButtonElement>(
        `[data-customize-proxy="${key}"]`,
      );
}

function beginInPlaceSession(): void {
  useCustomizeStore.setState({
    session: {
      scene: "in-place",
      opener: { kind: "none" },
      startedAt: Date.now(),
      pointerEntry: false,
    },
    history: { past: [], future: [] },
  });
}

beforeEach(() => {
  hostBindingMock.current = null;
  // jsdom does no layout. Give registered hotspots distinct boxes so this
  // passivity harness does not manufacture collisions between toolbar items.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const index = [
        ...useCustomizeStore.getState().instances.values(),
      ].findIndex((instance) => instance.node === this);
      return new DOMRect(20 + Math.max(0, index) * 50, 20, 40, 24);
    },
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
    function (this: Element) {
      const measured = this.getBoundingClientRect();
      return Object.assign([measured], {
        item: (index: number) => (index === 0 ? measured : null),
      });
    },
  );
  useThemeLibraryStore.setState({ panelAnimations: false });
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({ session: null, instances: new Map() });
});

afterEach(() => {
  act(() => {
    exitCustomize("studio-closed");
    useCustomizeStore.setState({ session: null, instances: new Map() });
  });
  cleanup();
  document.body.innerHTML = "";
  hostBindingMock.current = null;
  vi.restoreAllMocks();
});

describe("Customize in-place session over the live composer toolbar", () => {
  it("adds no host request, query or action handler across enter, model form, mic form, change, Undo and exit", async () => {
    const modelRegistrations = vi.spyOn(
      modelPickerRegistry,
      "registerActiveModelPicker",
    );
    const controlRegistrations = vi.spyOn(
      controlsRegistry,
      "registerFocusedComposerControls",
    );
    // Positive control: a real extra owner must be observable even over a
    // pre-existing owner. Dispose it before measuring the mounted toolbar.
    const probe = { toggle: () => {}, getSelectionSummary: () => null };
    const previousOwner = getActiveModelPicker();
    const disposeProbe = modelPickerRegistry.registerActiveModelPicker(probe);
    expect(modelRegistrations).toHaveBeenCalledWith(probe);
    expect(getActiveModelPicker()).toBe(probe);
    disposeProbe();
    expect(getActiveModelPicker()).toBe(previousOwner);
    modelRegistrations.mockClear();
    const probeControls: controlsRegistry.ComposerControls = {
      setReasoning: () => {},
      setServiceTier: () => {},
      setPermission: () => {},
      switchHarness: () => {},
      selectModel: () => {},
    };
    const disposeControls = controlsRegistry.registerFocusedComposerControls(
      "landing",
      probeControls,
      null,
    );
    expect(controlRegistrations).toHaveBeenCalledWith(
      "landing",
      probeControls,
      null,
    );
    expect(getFocusedComposerControls()?.controls).toBe(probeControls);
    disposeControls();
    controlRegistrations.mockClear();

    const { queryClient, messenger } = createRecordingHost();
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            fallback={null}
            messengerFactory={null}
            invalidator={null}
            requestId={null}
            remoteFetcher={null}
          >
            <SurfaceActivityProvider active>
              <TooltipProvider delayDuration={0}>
                <ComposerToolbar
                  store={toolbarStore()}
                  onAttachImages={() => undefined}
                  canSubmit
                  attachmentPending={false}
                  onSubmit={() => undefined}
                  activeTurnStatus={null}
                  stopDisabled={false}
                  onStopTurn={null}
                  composerDisabledHint={null}
                  dictation={{
                    state: "idle",
                    onToggle: () => undefined,
                    onStop: () => undefined,
                    onCancel: () => undefined,
                    getStream: () => null,
                  }}
                  dictationPreparing={null}
                  settingsLocked={false}
                  createProfileHostId={null}
                  runTargetHostId={null}
                  terminalLoginSurface={null}
                  chatLineCarriesAutoMode={null}
                />
                <CustomizeOverlay />
              </TooltipProvider>
            </SurfaceActivityProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );
    const send = await screen.findByTestId("toolbar-item-send");

    // The live toolbar's own queries settle first. Positive control: the
    // recorder demonstrably sees this toolbar's traffic, so an empty delta
    // below cannot be a broken spy.
    const rpc = () => messenger.calls.map((call) => call.method);
    const settleRpc = async () => {
      let previous = -1;
      for (
        let attempt = 0;
        attempt < 20 && previous !== rpc().length;
        attempt++
      ) {
        previous = rpc().length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      }
    };
    await waitFor(() => expect(rpc().length).toBeGreaterThan(0));
    await settleRpc();

    const observe = () => ({
      rpc: rpc(),
      queryKeys: queryClient
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.queryKey))
        .sort(),
      modelPickerOwner: getActiveModelPicker(),
      modelRegistrations: modelRegistrations.mock.calls.length,
      composerControlsOwner: getFocusedComposerControls(),
      controlRegistrations: controlRegistrations.mock.calls.length,
    });
    const before = observe();
    const assertNoDelta = (step: string): void => {
      const now = observe();
      expect(now.rpc, `${step}: host requests`).toEqual(before.rpc);
      expect(now.queryKeys, `${step}: queries`).toEqual(before.queryKeys);
      expect(now.modelRegistrations, `${step}: model registrations`).toBe(
        before.modelRegistrations,
      );
      expect(now.controlRegistrations, `${step}: control registrations`).toBe(
        before.controlRegistrations,
      );
      if (now.modelPickerOwner !== null)
        expect(now.modelPickerOwner).toBe(before.modelPickerOwner);
      if (now.composerControlsOwner !== null)
        expect(now.composerControlsOwner).toBe(before.composerControlsOwner);
      expect(
        screen.getByTestId("toolbar-item-send"),
        `${step}: same nodes`,
      ).toBe(send);
    };

    // 1. enter
    act(() => beginInPlaceSession());
    await waitFor(() => expect(proxyFor("composer.model")).not.toBeNull());
    await waitFor(() => expect(proxyFor("composer.mic")).not.toBeNull());
    await settleRpc();
    assertNoDelta("enter session");

    // 2. open the model form (its option pictures are passive previews of the
    //    chip; they must not start host work of their own)
    fireEvent.click(requireProxy("composer.model"));
    await screen.findByRole("radio", { name: "Bars" });
    await settleRpc();
    assertNoDelta("open model form");

    // 3. change it
    const indicatorBefore =
      useLayoutStore.getState().composer.reasoningIndicator;
    fireEvent.click(screen.getByRole("radio", { name: "Bars" }));
    expect(useLayoutStore.getState().composer.reasoningIndicator).toBe("bars");
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    await settleRpc();
    assertNoDelta("change model chip style");

    // 4. mic form, and change it (a live mic becomes a ghost anchor)
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(useCustomizeStore.getState().popoverKey).toBeNull(),
    );
    fireEvent.click(requireProxy("composer.mic"));
    await screen.findByRole("radio", { name: "Hidden" });
    assertNoDelta("open mic form");
    fireEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    expect(useCustomizeStore.getState().history.past).toHaveLength(2);
    await settleRpc();
    assertNoDelta("hide mic");

    // 5. Undo both gestures
    act(() => undo());
    act(() => undo());
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
    expect(useLayoutStore.getState().composer.reasoningIndicator).toBe(
      indicatorBefore,
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
    await settleRpc();
    assertNoDelta("undo");

    // 6. exit
    act(() => exitCustomize("done"));
    expect(useCustomizeStore.getState().session).toBeNull();
    expect(useCustomizeStore.getState().instances.size).toBe(0);
    await settleRpc();
    assertNoDelta("exit session");
  });
});
