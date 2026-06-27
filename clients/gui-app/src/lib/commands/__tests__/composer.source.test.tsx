import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  registerFocusedComposerControls,
  resetFocusedComposerControlsForTests,
} from "@/lib/commands/composer-controls-registry";
import { composerSource } from "@/lib/commands/sources/composer.source";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import type {
  CommandContext,
  CommandItem,
  FocusedComposerKind,
} from "@/lib/commands/types";
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
    resetCanvasStore();
    resetFocusedComposerControlsForTests();
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    createChatMock.mutate.mockReset();
    latestConversationWorkspaceSeedMock.seed = null;
    resetCanvasStore();
    resetFocusedComposerControlsForTests();
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  it("emits nothing when no composer is registered", () => {
    const items = captureItems(null, null);
    expect(items).toEqual([]);
  });

  it("landing composer shows provider / model; no new-chat items", () => {
    registerFocusedComposerControls("landing", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
    const ids = captureItems(null, "landing").map((i) => i.id);
    expect(ids).toContain("composer:switch-provider");
    expect(ids).toContain("composer:switch-model");
    // Host switching now lives on the chip; the Select PC palette
    // entry was removed alongside the dormant DeviceStore.
    expect(ids).not.toContain("composer:select-pc");
    expect(ids).not.toContain("composer:new-chat:replace");
  });

  it("chat-tile composer with an active epic shows the new-chat + terminal items; no Select PC", () => {
    registerFocusedComposerControls("chat-tile", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
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
    registerFocusedComposerControls("chat-tile", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
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
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("chat");
  });

  it("new-chat split command opens the modal in chat mode with the active group's split placement", () => {
    registerFocusedComposerControls("chat-tile", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
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
    registerFocusedComposerControls("chat-tile", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
    const ids = captureItems(null, "chat-tile").map((i) => i.id);
    expect(ids).not.toContain("composer:new-chat:replace");
  });

  it("provider / model entry items carry a subpage", () => {
    registerFocusedComposerControls("landing", {
      setSelection: () => undefined,
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });
    const items = captureItems(null, "landing");
    const provider = items.find((i) => i.id === "composer:switch-provider");
    const model = items.find((i) => i.id === "composer:switch-model");
    expect(provider?.subpage?.id).toBe("composer:provider");
    expect(model?.subpage?.id).toBe("composer:model");
  });

  it("model leaf item dispatches via the registered setter", () => {
    const selections: Array<{ harnessId: string; modelSlug: string }> = [];
    registerFocusedComposerControls("landing", {
      setSelection: (next) => selections.push(next),
      setReasoning: () => undefined,
      setServiceTier: () => undefined,
      setPermission: () => undefined,
    });

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
    expect(selections).toHaveLength(1);
    expect(typeof selections[0].harnessId).toBe("string");
    expect(typeof selections[0].modelSlug).toBe("string");
  });
});
