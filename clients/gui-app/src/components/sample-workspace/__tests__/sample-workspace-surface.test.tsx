import { SampleWorkspaceSurface } from "@/components/sample-workspace/sample-workspace-surface";
import {
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import {
  SAMPLE_TURNS,
  SAMPLE_TILE_ID,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import {
  getFocusedComposerControls,
  resetFocusedComposerControlsForTests,
} from "@/lib/commands/composer-controls-registry";
import {
  openActiveDraftsControl,
  resetActiveDraftsControlForTests,
} from "@/lib/commands/active-drafts-control-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  useCustomizeStore,
  type Opener,
} from "@/stores/customize/customize-store";
import {
  LEFT_PANEL_IDS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

const hostCalls = vi.hoisted(() => ({ methods: [] as string[] }));
const recordingClient = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "string" && prop !== "then"
            ? (..._args: unknown[]) => {
                hostCalls.methods.push(prop);
                return new Promise(() => undefined);
              }
            : undefined,
      },
    ),
);

// Every accessor a piece could reach a host through resolves to the recorder.
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: () => recordingClient,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => recordingClient,
  useOptionalHostClient: () => recordingClient,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const TILE = SAMPLE_TILE_ID;
const keyFor = (settingId: string, tileId: string): string =>
  `${settingId}@shell:${tileId}`;
const key = (settingId: string): string => keyFor(settingId, TILE);

const PIECE_KEYS: ReadonlyArray<string> = [
  key("composer.filesChanged"),
  key("composer.activeAgents"),
  key("composer.background"),
  key("composer.attachImage"),
  key("composer.access"),
  key("composer.harness"),
  key("composer.model"),
  key("composer.mic"),
  key("chat.context"),
  key("chat.minimapSide"),
];
const RAIL_KEYS: ReadonlyArray<string> = LEFT_PANEL_IDS.map((id) =>
  keyFor("sidebar.panel", id),
);

let queryClient: QueryClient;

function Probe(): ReactNode {
  return (
    <span data-testid="sample-probe">
      {useSampleScene() ? "sample" : "real"}
    </span>
  );
}

function renderBody() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <SampleSceneProvider>
              <Probe />
              <SampleWorkspaceBody />
            </SampleSceneProvider>
            <CustomizeOverlay />
          </TooltipProvider>
        </LazyMotion>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

function startSession(scene: "sample" | "in-place"): void {
  useCustomizeStore.setState({
    session: {
      scene,
      opener: { kind: "none" },
      startedAt: Date.now(),
      pointerEntry: false,
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
}

function instance(instanceKey: string) {
  return useCustomizeStore.getState().instances.get(instanceKey) ?? null;
}

function node(instanceKey: string): HTMLElement {
  const found = instance(instanceKey);
  if (found === null) throw new Error(`no instance ${instanceKey}`);
  return found.node;
}

function precedes(first: HTMLElement, second: HTMLElement): boolean {
  return (
    (first.compareDocumentPosition(second) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0
  );
}

function proxyFor(instanceKey: string): Element | null {
  return document.querySelector(`[data-customize-proxy="${instanceKey}"]`);
}

beforeEach(() => {
  hostCalls.methods.length = 0;
  localStorage.clear();
  // jsdom does no layout: every element measures as the same reachable box.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(20, 20, 40, 24),
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => {
    const measured = new DOMRect(20, 20, 40, 24);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  });
  useThemeLibraryStore.setState({ panelAnimations: false });
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useSettingsStore.setState({
    chatTurnMinimapSide: "right",
    visualLayoutEditorEnabled: true,
  });
  useLeftPanelStore.getState().clearPanelVisibilityOverrides();
  resetFocusedComposerControlsForTests();
  resetActiveDraftsControlForTests();
  startSession("sample");
});

afterEach(() => {
  act(() => {
    exitCustomize("studio-closed");
    useCustomizeStore.setState({ session: null, instances: new Map() });
  });
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SampleWorkspaceBody - content", () => {
  it("renders a scrollable transcript of every sample turn, with one tool block", () => {
    renderBody();

    expect(screen.getByLabelText("Sample conversation")).not.toBeNull();
    expect(document.querySelectorAll("[data-sample-turn]")).toHaveLength(
      SAMPLE_TURNS.length,
    );
    expect(screen.getAllByText(/Sample tool/)).toHaveLength(1);
  });

  it("renders the three populated dock rows, the composer, and the sample context chip", () => {
    renderBody();

    expect(screen.getByText(/Sample agent/)).not.toBeNull();
    expect(screen.getByText(/Sample shell/)).not.toBeNull();
    expect(screen.getByText("Describe the next change…")).not.toBeNull();
    expect(screen.getByText("Sample workspace")).not.toBeNull();
    expect(screen.getByTestId("context-usage-meter")).not.toBeNull();
  });

  it("draws a minimap from the sample turns", () => {
    renderBody();

    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(
      screen.getAllByTestId("chat-turn-minimap-tick").length,
    ).toBeGreaterThan(0);
  });

  it("is passive: dock, composer and transcript text are inert, the scroller is not", () => {
    renderBody();

    // Native scrolling must keep working, so the scroller itself is NOT inert...
    expect(
      screen.getByLabelText("Sample conversation").hasAttribute("inert"),
    ).toBe(false);
    // ...but the text inside it is, and so is everything from the dock down.
    const turn = document.querySelector("[data-sample-turn]");
    expect(turn?.closest("[inert]")).not.toBeNull();
    expect(screen.getByText(/Sample agent/).closest("[inert]")).not.toBeNull();
    expect(
      screen.getByText("Describe the next change…").closest("[inert]"),
    ).not.toBeNull();
    // The minimap and rail are hotspots the editor reaches through proxies.
    expect(
      screen.getByTestId("chat-turn-minimap").closest("[inert]"),
    ).toBeNull();
  });
});

describe("SampleWorkspaceBody - hotspots and proxies", () => {
  it("registers every composer, chat and rail hotspot under the sample tile", () => {
    renderBody();

    const registered = [...useCustomizeStore.getState().instances.keys()];
    expect(registered).toEqual(
      expect.arrayContaining([...PIECE_KEYS, ...RAIL_KEYS]),
    );
    expect(RAIL_KEYS).toHaveLength(LEFT_PANEL_IDS.length);
  });

  it("draws a real overlay proxy for each registered hotspot", async () => {
    renderBody();

    await waitFor(() => {
      for (const registered of [...PIECE_KEYS, ...RAIL_KEYS])
        expect(proxyFor(registered)).not.toBeNull();
    });
  });

  it("ghosts what the sample cannot show, with the reason", () => {
    renderBody();

    // No dictation control -> mic is a ghost, same wording as the live composer.
    expect(instance(key("composer.mic"))).toMatchObject({
      ghost: true,
      condition: "voice input is not available on this host",
    });
    // Rail presence is all-false, so the presence-gated panels are ghosts.
    expect(instance(keyFor("sidebar.panel", "pull-requests"))).toMatchObject({
      ghost: true,
      condition: "No PRs yet",
    });
    expect(instance(keyFor("sidebar.panel", "comments"))).toMatchObject({
      ghost: true,
      condition: "Needs an open artifact",
    });
    expect(instance(keyFor("sidebar.panel", "chats"))?.ghost).toBe(false);
    // The context chip has sample usage, so it is a real (non-ghost) hotspot.
    expect(instance(key("chat.context"))).toMatchObject({
      ghost: false,
      condition: null,
    });
  });

  it("unregisters everything when the session ends", () => {
    renderBody();
    expect(useCustomizeStore.getState().instances.size).toBeGreaterThan(0);

    act(() => {
      useCustomizeStore.setState({ session: null });
    });

    expect(useCustomizeStore.getState().instances.size).toBe(0);
  });
});

describe("SampleWorkspaceBody - passivity", () => {
  it("issues zero host calls and starts no host-scoped query", async () => {
    renderBody();
    await waitFor(() => expect(proxyFor(key("composer.model"))).not.toBeNull());

    expect(hostCalls.methods).toEqual([]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("registers no dynamic action handler", async () => {
    renderBody();
    await waitFor(() => expect(proxyFor(key("composer.model"))).not.toBeNull());

    expect(getActiveModelPicker()).toBeNull();
    expect(getFocusedComposerControls()).toBeNull();
    expect(openActiveDraftsControl()).toBe(false);
  });
});

describe("SampleWorkspaceBody - preferences re-render the real pieces", () => {
  it("reordering the dock reorders the rows", () => {
    renderBody();
    const before = ["filesChanged", "activeAgents", "background"].map((id) =>
      node(key(`composer.${id}`)),
    );
    expect(precedes(before[0], before[1])).toBe(true);
    expect(precedes(before[1], before[2])).toBe(true);

    act(() => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          dockOrder: ["background", "filesChanged", "activeAgents"],
        },
      });
    });

    const background = node(key("composer.background"));
    const files = node(key("composer.filesChanged"));
    const agents = node(key("composer.activeAgents"));
    expect(precedes(background, files)).toBe(true);
    expect(precedes(files, agents)).toBe(true);
  });

  it("folding a dock row to compact swaps its row for a strip chip that is still the hotspot", () => {
    renderBody();
    expect(screen.getByText(/Sample shell/)).not.toBeNull();

    act(() => {
      useLayoutStore.setState({
        composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
      });
    });

    expect(screen.queryByText(/Sample shell/)).toBeNull();
    expect(screen.getByText(/Sample agent/)).not.toBeNull();
    const strip = screen.getByTestId("chat-dock-compact-strip");
    expect(screen.getByTestId("chat-dock-chip-background")).not.toBeNull();
    expect(strip.contains(node(key("composer.background")))).toBe(true);
  });

  it("reordering the toolbar reorders its hotspots", () => {
    renderBody();
    expect(
      precedes(node(key("composer.attachImage")), node(key("composer.access"))),
    ).toBe(true);
    expect(
      precedes(node(key("composer.model")), node(key("composer.mic"))),
    ).toBe(true);

    act(() => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          toolbar: {
            left: ["harness", "access", "attachImage"],
            right: ["mic", "model"],
          },
        },
      });
    });

    expect(
      precedes(node(key("composer.harness")), node(key("composer.access"))),
    ).toBe(true);
    expect(
      precedes(node(key("composer.access")), node(key("composer.attachImage"))),
    ).toBe(true);
    expect(
      precedes(node(key("composer.mic")), node(key("composer.model"))),
    ).toBe(true);
  });

  it("minimap side moves the minimap, and 'hide' ghosts its hotspot", () => {
    renderBody();
    expect(
      screen.getByTestId("chat-turn-minimap").getAttribute("data-side"),
    ).toBe("right");

    act(() => {
      useSettingsStore.setState({ chatTurnMinimapSide: "left" });
    });
    expect(
      screen.getByTestId("chat-turn-minimap").getAttribute("data-side"),
    ).toBe("left");

    act(() => {
      useSettingsStore.setState({ chatTurnMinimapSide: "hide" });
    });
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(instance(key("chat.minimapSide"))).toMatchObject({
      ghost: true,
      condition: "Hidden",
    });

    act(() => {
      useSettingsStore.setState({ chatTurnMinimapSide: "right" });
    });
    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(instance(key("chat.minimapSide"))?.ghost).toBe(false);
  });

  it("a panel visibility override ghosts or un-ghosts its rail tile", () => {
    renderBody();
    expect(instance(keyFor("sidebar.panel", "chats"))?.ghost).toBe(false);
    expect(instance(keyFor("sidebar.panel", "pull-requests"))?.ghost).toBe(
      true,
    );

    act(() => {
      useLeftPanelStore.getState().setPanelVisibilityOverride("chats", false);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("pull-requests", true);
    });

    expect(instance(keyFor("sidebar.panel", "chats"))?.ghost).toBe(true);
    expect(instance(keyFor("sidebar.panel", "pull-requests"))?.ghost).toBe(
      false,
    );
  });
});

describe("SampleWorkspaceBody - sample labelling", () => {
  it("SampleSceneProvider reads 'sample' only while a sample-scene session is live", () => {
    renderBody();
    expect(screen.getByTestId("sample-probe").textContent).toBe("sample");

    act(() => startSession("in-place"));
    expect(screen.getByTestId("sample-probe").textContent).toBe("real");

    act(() => startSession("sample"));
    expect(screen.getByTestId("sample-probe").textContent).toBe("sample");

    act(() => {
      useCustomizeStore.setState({ session: null });
    });
    expect(screen.getByTestId("sample-probe").textContent).toBe("real");
  });
});

const SURFACE_EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };
const SURFACE_SAMPLE_REF: TabRef = {
  kind: "sample-workspace",
  id: "sample-workspace",
};
const PERSISTENT_LINE = "Sample content. Changes apply to your layout.";

// No explicit return type: the vi.fn mocks must stay assertable.
function fakeModalApi() {
  return {
    active: null,
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
    promoteToTab: vi.fn(),
    isOverlayActive: () => false,
  };
}

function sampleTabCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

/** Materialized sample tab, selected, feature on: what the surface sees in the app. */
function seedActiveSampleTab(opener: Opener): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [
      {
        kind: "tab",
        id: tabItemId(SURFACE_EPIC_REF),
        ref: SURFACE_EPIC_REF,
      },
    ],
    activeItemId: tabItemId(SURFACE_EPIC_REF),
    stripOrder: [SURFACE_EPIC_REF],
  });
  ensureSampleWorkspaceTab(opener);
  useTabsStore.setState({ activeItemId: tabItemId(SURFACE_SAMPLE_REF) });
}

function renderSurface() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <CustomizeOverlay />
            <SampleSceneProvider>
              <SampleWorkspaceSurface tabId="sample-workspace" />
            </SampleSceneProvider>
          </TooltipProvider>
        </LazyMotion>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

describe("SampleWorkspaceSurface - real Done and Escape through the overlay", () => {
  const SETTINGS_OPENER: Opener = {
    kind: "settings-modal",
    section: "layout",
    scrollTop: 0,
  };

  beforeEach(() => {
    act(() => {
      useCustomizeStore.setState({ session: null, instances: new Map() });
    });
    tabCommandCoordinator.resetReconciliationForTesting();
  });

  afterEach(() => {
    if (useCustomizeStore.getState().session) exitCustomize("done");
    setSystemTabModalApi(null);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  });

  it("enters a real sample session on mount and shows the persistent line", () => {
    setSystemTabModalApi(fakeModalApi());
    seedActiveSampleTab(SETTINGS_OPENER);

    renderSurface();

    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(screen.getByText(PERSISTENT_LINE)).not.toBeNull();
    expect(sampleTabCount()).toBe(1);
  });

  it("clicking Done ends the session, closes the sample tab and reopens the opener", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    seedActiveSampleTab(SETTINGS_OPENER);
    renderSurface();
    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(screen.getByText(PERSISTENT_LINE)).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    expect(useCustomizeStore.getState().session).toBeNull();
    await waitFor(() => expect(sampleTabCount()).toBe(0));
    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
  });

  it("pressing Escape ends the session, closes the sample tab and reopens the opener", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    seedActiveSampleTab(SETTINGS_OPENER);
    renderSurface();
    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(screen.getByText(PERSISTENT_LINE)).not.toBeNull();
    // Nothing open, nothing searched: the first Escape must reach exitCustomize.
    await screen.findByRole("button", { name: "Done" });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(useCustomizeStore.getState().session).toBeNull();
    await waitFor(() => expect(sampleTabCount()).toBe(0));
    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
  });

  it("Done with no opener closes the tab and opens nothing", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    seedActiveSampleTab({ kind: "none" });
    renderSurface();

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    expect(useCustomizeStore.getState().session).toBeNull();
    await waitFor(() => expect(sampleTabCount()).toBe(0));
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("Escape while a search query is set only clears the query; the session and tab survive", async () => {
    setSystemTabModalApi(fakeModalApi());
    seedActiveSampleTab(SETTINGS_OPENER);
    renderSurface();
    await screen.findByRole("button", { name: "Done" });
    act(() => {
      useCustomizeStore.getState().setSearch("model", -1);
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(useCustomizeStore.getState().search.query).toBe("");
    expect(sampleTabCount()).toBe(1);
  });
});
