import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  registerFocusedComposerControls,
  resetFocusedComposerControlsForTests,
  type ComposerControls,
} from "@/lib/commands/composer-controls-registry";
import {
  registerActiveModelPicker,
  resetActiveModelPickerForTests,
} from "@/lib/commands/active-model-picker-registry";
import { composerSource } from "@/lib/commands/sources/composer.source";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
  FocusedComposerKind,
} from "@/lib/commands/types";
import type { HostRpcRegistry } from "@/lib/host";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

const catalogMock = vi.hoisted(() => ({
  harnesses: [
    {
      id: "codex",
      label: "Codex",
      available: true,
      error: null,
      models: [
        {
          harnessId: "codex",
          slug: "gpt-live",
          label: "GPT Live",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
      modelsLoading: false,
      modelsError: null,
    },
  ],
}));

/**
 * Minimal shape the mocked `useDefaultHostClient` / `useGuiHarnessCatalogForClient`
 * need: only object identity matters to the assertions below (which host's
 * catalog the subpages asked for), never any real RPC behavior.
 */
interface FakeCatalogHostClient {
  readonly getActiveHostId: () => string | null;
}

const focusedComposerCatalogMock = vi.hoisted(() => ({
  defaultClient: { getActiveHostId: () => "default-host" },
  clientCalls: [] as Array<{ getActiveHostId: () => string | null } | null>,
}));

interface CreateChatPayload {
  readonly epicId: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly chatId: string;
  readonly worktreeIntent: WorktreeIntent | null;
}

interface CreateChatOptions {
  readonly onSuccess: () => void;
}

const createChatMock = vi.hoisted(() => ({
  mutate:
    vi.fn<(payload: CreateChatPayload, options: CreateChatOptions) => void>(),
}));
const latestConversationWorkspaceSeedMock = vi.hoisted(() => ({
  seed: null as { readonly intent: WorktreeIntent | null } | null,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalog: () => ({
    harnesses: catalogMock.harnesses,
    harnessesLoading: false,
    harnessesError: null,
    modelsLoading: false,
  }),
  useDefaultHostClient: (): FakeCatalogHostClient =>
    focusedComposerCatalogMock.defaultClient,
  // Records the `client` each call was invoked with, so tests can assert the
  // composer subpages resolve the FOCUSED composer's host client (not the
  // default host's) - regardless of which client was passed, this returns
  // the same fixture catalog `useGuiHarnessCatalog` above does, since none of
  // this file's cases need per-host catalog content, only per-host routing.
  useGuiHarnessCatalogForClient: (client: FakeCatalogHostClient | null) => {
    focusedComposerCatalogMock.clientCalls.push(client);
    return {
      harnesses: catalogMock.harnesses,
      harnessesLoading: false,
      harnessesError: null,
      modelsLoading: false,
    };
  },
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChat: () => ({
    mutate: createChatMock.mutate,
  }),
}));
vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () =>
    latestConversationWorkspaceSeedMock.seed,
}));

function ctx(
  activeEpicId: string | null,
  focusedComposerKind: FocusedComposerKind | null,
): CommandContext {
  return {
    pathname:
      activeEpicId === null ? "/" : `/epics/${activeEpicId}/${activeEpicId}`,
    router: {
      getPathname: () => "/",
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    },
    activeTabId: activeEpicId,
    activeEpicId,
    focusedComposerKind,
    targetGroupId: null,
  };
}

function captureItems(
  activeEpicId: string | null,
  focusedComposerKind: FocusedComposerKind | null,
): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = composerSource.useItems(ctx(activeEpicId, focusedComposerKind));
    return null;
  }
  render(<Probe />);
  return captured;
}

function renderSubpageItems(
  subpage: CommandSubpage,
  focusedComposerKind: FocusedComposerKind,
): void {
  function SubProbe() {
    subpage.useItems(ctx(null, focusedComposerKind));
    return null;
  }
  render(<SubProbe />);
}

function stubControls(overrides: Partial<ComposerControls>): ComposerControls {
  return {
    setReasoning: () => undefined,
    setServiceTier: () => undefined,
    setPermission: () => undefined,
    switchHarness: () => undefined,
    selectModel: () => undefined,
    ...overrides,
  };
}

/**
 * A real, distinct `HostClient` instance (never a cast) so identity
 * assertions on `FocusedComposerEntry.hostClient` compare the exact object a
 * test registered, not some other host's client. Never actually dispatched -
 * `registerFocusedComposerControls`'s consumers here only read it back
 * (nothing in this file issues a real RPC through it).
 */
function buildTestHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  });
  return client;
}

// The host client every pre-existing test in this file registers a focused
// composer with - non-null, so the composer subpages list a resolved host's
// catalog exactly as they did before `hostClient` became part of the entry.
// Its identity is irrelevant to those tests; only the tests that assert
// per-host routing below construct their own distinct clients.
const TEST_HOST_CLIENT = buildTestHostClient("test-host");

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
    selfDeletedArtifactIds: new Set<string>(),
    preAckRootCreatesByEpic: {},
    pendingRootCreatesByEpic: {},
  });
}

describe("composerSource", () => {
  beforeEach(() => {
    createChatMock.mutate.mockReset();
    latestConversationWorkspaceSeedMock.seed = null;
    focusedComposerCatalogMock.clientCalls.length = 0;
    resetCanvasStore();
    resetFocusedComposerControlsForTests();
    resetActiveModelPickerForTests();
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    createChatMock.mutate.mockReset();
    latestConversationWorkspaceSeedMock.seed = null;
    focusedComposerCatalogMock.clientCalls.length = 0;
    resetCanvasStore();
    resetFocusedComposerControlsForTests();
    resetActiveModelPickerForTests();
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  it("emits nothing when no composer is registered", () => {
    const items = captureItems(null, null);
    expect(items).toEqual([]);
  });

  it("landing composer shows provider / model; no new-chat items", () => {
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const ids = captureItems(null, "landing").map((i) => i.id);
    expect(ids).toContain("composer:switch-provider");
    expect(ids).toContain("composer:switch-model");
    // Host switching now lives on the chip; the Select PC palette
    // entry was removed alongside the dormant DeviceStore.
    expect(ids).not.toContain("composer:select-pc");
    expect(ids).not.toContain("composer:new-chat:replace");
  });

  it("emits a context-gated Stash prompt row bound to composer.stash", () => {
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const item = captureItems(null, "landing").find(
      (row) => row.id === "composer:stash-prompt",
    );
    expect(item).toBeDefined();
    expect(item?.actionId).toBe("composer.stash");
    expect(item?.label).toBe("Stash prompt");
    expect(item?.shortcut).toBe("mod+s");
  });

  it("hides Change model… when no picker is registered", () => {
    // A focused composer with no active picker (e.g. locked/pending) registers
    // its controls but not a picker, so the toggle would no-op.
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const ids = captureItems(null, "landing").map((i) => i.id);
    expect(ids).not.toContain("composer:open-model-picker");
  });

  it("shows Change model… with the active selection when a picker is registered", () => {
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    registerActiveModelPicker({
      toggle: () => undefined,
      getSelectionSummary: () => "Claude Opus 4.8",
    });
    const item = captureItems(null, "landing").find(
      (i) => i.id === "composer:open-model-picker",
    );
    expect(item).not.toBeUndefined();
    expect(item?.description).toBe("Claude Opus 4.8");
  });

  it("refreshes the Change model… summary when the top picker is swapped", () => {
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    registerActiveModelPicker({
      toggle: () => undefined,
      getSelectionSummary: () => "base",
    });

    let captured: ReadonlyArray<CommandItem> = [];
    function Probe() {
      captured = composerSource.useItems(ctx(null, "landing"));
      return null;
    }
    render(<Probe />);
    const description = () =>
      captured.find((i) => i.id === "composer:open-model-picker")?.description;
    expect(description()).toBe("base");

    // Push an overlay picker on top (non-empty -> non-empty): the snapshot is
    // the controller itself, so the row re-renders and the summary follows.
    act(() => {
      registerActiveModelPicker({
        toggle: () => undefined,
        getSelectionSummary: () => "overlay",
      });
    });
    expect(description()).toBe("overlay");
  });

  it("chat-tile composer with an active epic shows the new-chat + terminal items; no Select PC", () => {
    registerFocusedComposerControls(
      "chat-tile",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const ids = captureItems("epic-1", "chat-tile").map((i) => i.id);
    expect(ids).toContain("composer:switch-provider");
    expect(ids).toContain("composer:switch-model");
    expect(ids).not.toContain("composer:select-pc");
    expect(ids).toContain("composer:new-chat:replace");
    expect(ids).toContain("composer:new-chat:split:right");
    expect(ids).toContain("composer:new-chat:split:bottom");
    expect(ids).toContain("composer:new-terminal-agent");
  });

  it("new-chat active tile command opens the modal in chat mode (active-tile)", () => {
    registerFocusedComposerControls(
      "chat-tile",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const items = captureItems("epic-1", "chat-tile");
    const item = items.find((candidate) => {
      return candidate.id === "composer:new-chat:replace";
    });
    expect(item).not.toBeUndefined();
    if (item === undefined) return;

    void item.run(ctx("epic-1", "chat-tile"));

    // The command no longer creates directly; it opens the shared modal which
    // owns the compose-then-create flow.
    expect(createChatMock.mutate).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "epic-1",
      placement: { kind: "active-tile" },
      parentId: null,
      hostId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("chat");
  });

  it("new-chat split command opens the modal in chat mode with the active group's split placement", () => {
    registerFocusedComposerControls(
      "chat-tile",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    useEpicCanvasStore
      .getState()
      .seedEpic("epic-1", { tabId: "epic-1", name: "Epic 1" }, []);
    useEpicCanvasStore.getState().openTileInTab("epic-1", {
      id: "existing-spec",
      instanceId: "inst-existing-spec",
      type: "spec",
      name: "Existing spec",
      hostId: "test-host",
    });
    const activeGroupId =
      useEpicCanvasStore.getState().canvasByTabId["epic-1"]?.activePaneId ??
      null;
    if (activeGroupId === null) throw new Error("expected an active group");
    const items = captureItems("epic-1", "chat-tile");
    const item = items.find((candidate) => {
      return candidate.id === "composer:new-chat:split:right";
    });
    expect(item).not.toBeUndefined();
    if (item === undefined) return;

    void item.run(ctx("epic-1", "chat-tile"));

    // The command opens the modal (no direct create) and leaves the canvas
    // untouched until submit; placement carries the active group + edge.
    expect(createChatMock.mutate).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "epic-1",
      placement: { kind: "split", groupId: activeGroupId, position: "right" },
      parentId: null,
      hostId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("chat");
    const canvas = useEpicCanvasStore.getState().canvasByTabId["epic-1"];
    if (canvas === undefined) throw new Error("expected seeded tab canvas");
    expect(collectPanes(canvas.root)).toHaveLength(1);
  });

  it("chat-tile without an active epic hides new-chat items", () => {
    registerFocusedComposerControls(
      "chat-tile",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const ids = captureItems(null, "chat-tile").map((i) => i.id);
    expect(ids).not.toContain("composer:new-chat:replace");
  });

  it("provider / model entry items carry a subpage", () => {
    registerFocusedComposerControls(
      "landing",
      stubControls({}),
      TEST_HOST_CLIENT,
    );
    const items = captureItems(null, "landing");
    const provider = items.find((i) => i.id === "composer:switch-provider");
    const model = items.find((i) => i.id === "composer:switch-model");
    expect(provider?.subpage?.id).toBe("composer:provider");
    expect(model?.subpage?.id).toBe("composer:model");
  });

  it("model leaf item dispatches the memory-aware selectModel control", () => {
    const picks: Array<{ harnessId: string; modelSlug: string }> = [];
    registerFocusedComposerControls(
      "landing",
      stubControls({
        selectModel: (harnessId, modelSlug) =>
          picks.push({ harnessId, modelSlug }),
      }),
      TEST_HOST_CLIENT,
    );

    const items = captureItems(null, "landing");
    const modelEntry = items.find((i) => i.id === "composer:switch-model");
    expect(modelEntry?.subpage).not.toBeNull();
    if (modelEntry?.subpage === null || modelEntry?.subpage === undefined) {
      return;
    }
    // Drive the subpage hook directly via a probe.
    let subItems: ReadonlyArray<CommandItem> = [];
    const subpage = modelEntry.subpage;
    function SubProbe() {
      subItems = subpage.useItems(ctx(null, "landing"));
      return null;
    }
    render(<SubProbe />);
    expect(subItems.length).toBeGreaterThan(0);
    if (subItems.length === 0) return;
    const firstModel = subItems[0];
    void firstModel.run(ctx(null, "landing"));
    // The leaf funnels through `selectModel` (memory-aware), NOT bare
    // `setSelection`, so the pick restores that pair's remembered effort/tier.
    expect(picks).toEqual([{ harnessId: "codex", modelSlug: "gpt-live" }]);
  });

  it("provider leaf item dispatches the memory-aware switchHarness control", () => {
    const switches: Array<string> = [];
    registerFocusedComposerControls(
      "landing",
      stubControls({
        switchHarness: (harnessId) => switches.push(harnessId),
      }),
      TEST_HOST_CLIENT,
    );

    const items = captureItems(null, "landing");
    const providerEntry = items.find(
      (i) => i.id === "composer:switch-provider",
    );
    expect(providerEntry?.subpage).not.toBeNull();
    if (
      providerEntry?.subpage === null ||
      providerEntry?.subpage === undefined
    ) {
      return;
    }
    let subItems: ReadonlyArray<CommandItem> = [];
    const subpage = providerEntry.subpage;
    function SubProbe() {
      subItems = subpage.useItems(ctx(null, "landing"));
      return null;
    }
    render(<SubProbe />);
    expect(subItems.length).toBeGreaterThan(0);
    if (subItems.length === 0) return;
    void subItems[0].run(ctx(null, "landing"));
    // Switch-provider funnels through `switchHarness` (restores the harness's
    // remembered model/effort/tier), never the old `setSelection(firstModel…)`.
    // (`setSelection` is no longer part of `ComposerControls` at all.)
    expect(switches).toEqual(["codex"]);
  });

  it("the provider and model subpages resolve the FOCUSED composer's host client, not the default host's", () => {
    const hostClientB = buildTestHostClient("host-b");
    registerFocusedComposerControls("landing", stubControls({}), hostClientB);

    const items = captureItems(null, "landing");
    const providerSubpage = items.find(
      (i) => i.id === "composer:switch-provider",
    )?.subpage;
    const modelSubpage = items.find(
      (i) => i.id === "composer:switch-model",
    )?.subpage;
    if (providerSubpage === null || providerSubpage === undefined) {
      throw new Error("expected a provider subpage");
    }
    if (modelSubpage === null || modelSubpage === undefined) {
      throw new Error("expected a model subpage");
    }

    renderSubpageItems(providerSubpage, "landing");
    expect(focusedComposerCatalogMock.clientCalls.at(-1)).toBe(hostClientB);

    renderSubpageItems(modelSubpage, "landing");
    expect(focusedComposerCatalogMock.clientCalls.at(-1)).toBe(hostClientB);
  });

  it("with no focused composer registered, the provider subpage resolves the default host's client", () => {
    // `ctx.focusedComposerKind` (below) only decides which top-level items
    // render; `useFocusedComposerCatalog` reads the REGISTRY instead - never
    // populated in this test - to decide "focused or not". This models a
    // palette rendered while no composer has registered itself as focused.
    const items = captureItems(null, "landing");
    const providerSubpage = items.find(
      (i) => i.id === "composer:switch-provider",
    )?.subpage;
    if (providerSubpage === null || providerSubpage === undefined) {
      throw new Error("expected a provider subpage");
    }

    renderSubpageItems(providerSubpage, "landing");

    expect(focusedComposerCatalogMock.clientCalls.at(-1)).toBe(
      focusedComposerCatalogMock.defaultClient,
    );
  });

  it("a focused composer whose host client hasn't resolved yet is passed through as null, never the default host's", () => {
    registerFocusedComposerControls("landing", stubControls({}), null);

    const items = captureItems(null, "landing");
    const modelSubpage = items.find(
      (i) => i.id === "composer:switch-model",
    )?.subpage;
    if (modelSubpage === null || modelSubpage === undefined) {
      throw new Error("expected a model subpage");
    }

    renderSubpageItems(modelSubpage, "landing");

    expect(focusedComposerCatalogMock.clientCalls.at(-1)).toBeNull();
  });
});
