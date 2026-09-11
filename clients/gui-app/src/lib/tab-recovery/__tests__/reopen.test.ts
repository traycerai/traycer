import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonContent } from "@traycer/protocol/common/registry";
import type { PrepareNestedFocusTarget } from "@/lib/epic-nested-focus-navigation";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { EpicCanvasState, EpicViewTab } from "@/stores/epics/canvas/types";
import {
  SPEC_A,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  useTabRecoveryHistory,
  type ClosedHeaderTab,
  type LegacyRecoveryDraft,
  type TabRecoveryEntry,
} from "@/lib/tab-recovery/history";
import { reopenClosedTab } from "@/lib/tab-recovery/reopen";

const mocks = vi.hoisted(() => {
  const tabsById: Record<string, EpicViewTab | undefined> = {};
  const canvasByTabId: Record<string, EpicCanvasState | undefined> = {};
  return {
    restoreClosedHeaderTabs:
      vi.fn<
        (
          items: readonly ClosedHeaderTab[],
          replaceEmptyDraftId: string | null,
        ) => void
      >(),
    navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
    prepareSavedDraft:
      vi.fn<
        (item: ClosedHeaderTab, stillCurrent: () => boolean) => Promise<boolean>
      >(),
    landingDrafts: [] as Array<{
      readonly id: string;
      readonly closed: boolean;
    }>,
    scheduleLandingImageReconcile: vi.fn<() => void>(),
    toastInfo: vi.fn<(message: string, options: unknown) => void>(),
    canvasState: {
      openTabOrder: [] as string[],
      tabsById,
      canvasByTabId,
      selfDeletedArtifactIds: new Set<string>(),
      pendingCreateArtifactIds: new Set<string>(),
      restoreCanvasForRecovery: vi.fn<
        (
          tabId: string,
          options: {
            readonly before: EpicCanvasState;
            readonly after: EpicCanvasState;
            readonly instanceIds: readonly string[];
            readonly paneIds: readonly string[];
            readonly focus: boolean;
          },
        ) => void
      >(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: vi.fn(() => mocks.canvasState),
  },
}));

vi.mock("@/stores/home/landing-draft-store", () => ({
  useLandingDraftStore: {
    getState: vi.fn(() => ({ drafts: mocks.landingDrafts })),
  },
}));

vi.mock("../saved-draft", () => ({
  prepareSavedDraft: mocks.prepareSavedDraft,
}));

vi.mock("@/stores/tabs/tab-command-coordinator", () => ({
  tabCommandCoordinator: {
    restoreClosedHeaderTabs: mocks.restoreClosedHeaderTabs,
  },
}));

vi.mock("@/lib/tab-navigation/intents", () => ({
  draftTabIntent: vi.fn((draftId: string) => ({ kind: "draft", draftId })),
  existingEpicTabIntentWithNestedFocus: vi.fn(
    (input: { readonly epicId: string; readonly tabId: string }) => ({
      kind: "epic",
      epicId: input.epicId,
      tabId: input.tabId,
    }),
  ),
}));

vi.mock("@/lib/commands/actions/history-navigation", () => ({
  preservedTileRecordIsLive: vi.fn(() => true),
}));

vi.mock("@/lib/terminals/plain-terminal-presentation-invalidation", () => ({
  rejectClosedPlainTerminalRestore: vi.fn(() => false),
}));

vi.mock("@/lib/query-client", () => ({ queryClient: {} }));

vi.mock("@/lib/composer/landing-image-gc", () => ({
  scheduleLandingImageReconcile: mocks.scheduleLandingImageReconcile,
}));

vi.mock("@/stores/epics/canvas/migrate-canvas", () => ({
  parseEpicCanvasState: vi.fn((value: EpicCanvasState) => value),
}));

vi.mock("@/stores/epics/canvas/tile-tree", () => ({
  collectPanes: vi.fn(() => []),
  findPaneById: vi.fn(() => null),
}));

const EMPTY_CANVAS: EpicCanvasState = {
  root: null,
  activePaneId: null,
  tilesByInstanceId: {},
  sizesByGroupId: {},
};

function router(
  pathname: string,
  navigateNestedFocus: KeybindingRouter["navigateNestedFocus"] | undefined,
): KeybindingRouter {
  const base: KeybindingRouter = {
    getPathname: () => pathname,
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: (intent) => mocks.navigateToTabIntent(intent),
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
  return navigateNestedFocus === undefined
    ? base
    : { ...base, navigateNestedFocus };
}

function epicEntry(input: {
  readonly id: string;
  readonly bulk: boolean;
}): Extract<TabRecoveryEntry, { kind: "header" }> {
  return {
    id: input.id,
    kind: "header",
    bulk: input.bulk,
    items: [
      {
        kind: "epic",
        index: 0,
        tab: { tabId: "tab-1", epicId: "epic-1", name: "Task" },
        canvas: EMPTY_CANVAS,
      },
    ],
  };
}

function canvasSnapshot(instanceIds: readonly string[]): EpicCanvasState {
  return {
    root: pane("pane-1", instanceIds),
    activePaneId: "pane-1",
    tilesByInstanceId: Object.fromEntries(
      instanceIds.map((instanceId) => [instanceId, SPEC_A]),
    ),
    sizesByGroupId: {},
  };
}

function canvasEntry(input: {
  readonly id: string;
  readonly bulk: boolean;
}): Extract<TabRecoveryEntry, { kind: "canvas" }> {
  const before = canvasSnapshot([SPEC_A.instanceId]);
  return {
    id: input.id,
    kind: "canvas",
    bulk: input.bulk,
    tab: { tabId: "tab-1", epicId: "epic-1", name: "Task" },
    before,
    after: EMPTY_CANVAS,
    instanceIds: [SPEC_A.instanceId],
  };
}

function draft(content: JsonContent): LegacyRecoveryDraft {
  return {
    id: "draft-1",
    content,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: {
      folders: [],
      primaryPath: null,
      folderInfoByPath: {},
    },
  };
}

function draftRef(
  content: JsonContent,
  draftId = "draft-1",
): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId,
    hostId: null,
    legacyDraft: { ...draft(content), id: draftId },
    index: 0,
  };
}

function mountInput(testId: string | null): HTMLInputElement {
  const input = document.createElement("input");
  if (testId === null) {
    document.body.append(input);
    return input;
  }
  const container = document.createElement("div");
  container.dataset.testid = testId;
  container.append(input);
  document.body.append(container);
  return input;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

beforeEach(() => {
  mocks.restoreClosedHeaderTabs.mockReset();
  mocks.navigateToTabIntent.mockReset();
  mocks.prepareSavedDraft.mockReset();
  mocks.prepareSavedDraft.mockResolvedValue(true);
  mocks.landingDrafts.length = 0;
  mocks.scheduleLandingImageReconcile.mockReset();
  mocks.toastInfo.mockReset();
  mocks.canvasState.openTabOrder.length = 0;
  for (const key of Object.keys(mocks.canvasState.tabsById))
    delete mocks.canvasState.tabsById[key];
  for (const key of Object.keys(mocks.canvasState.canvasByTabId))
    delete mocks.canvasState.canvasByTabId[key];
  mocks.canvasState.restoreCanvasForRecovery.mockReset();
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("reopenClosedTab", () => {
  it("navigates to a single recovered task from another task", async () => {
    useTabRecoveryHistory.setState({
      entries: [epicEntry({ id: "entry-1", bulk: false })],
      ready: true,
    });

    await reopenClosedTab(router("/epics/other/other-tab", undefined));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("restores a bulk close without changing focus while already on that task", async () => {
    useTabRecoveryHistory.setState({
      entries: [epicEntry({ id: "entry-1", bulk: true })],
      ready: true,
    });

    await reopenClosedTab(router("/epics/epic-1/tab-1", undefined));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("reopens a saved draft by reference so the store supplies its latest content", async () => {
    const item: Extract<ClosedHeaderTab, { kind: "draft" }> = {
      kind: "draft",
      draftId: "saved-draft",
      hostId: "host-1",
      index: 0,
    };
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/", undefined));

    expect(mocks.prepareSavedDraft).toHaveBeenCalledWith(
      item,
      expect.any(Function),
    );
    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith([item], null);
    expect(item).not.toHaveProperty("legacyDraft");
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("restores navigation after preparing an open host draft as a closed mirror", async () => {
    const item: Extract<ClosedHeaderTab, { kind: "draft" }> = {
      kind: "draft",
      draftId: "host-open-draft",
      hostId: "host-1",
      index: 0,
    };
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockImplementation((draftItem, current) => {
      if (draftItem.kind !== "draft") return Promise.resolve(false);
      expect(draftItem.hostId).toBe("host-1");
      if (!current()) return Promise.resolve(false);
      mocks.landingDrafts.push({ id: draftItem.draftId, closed: true });
      return Promise.resolve(true);
    });

    await reopenClosedTab(router("/", undefined));

    expect(mocks.landingDrafts).toEqual([
      { id: "host-open-draft", closed: true },
    ]);
    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith([item], null);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "draft",
      draftId: "host-open-draft",
    });
  });

  it("keeps the recovery entry when a draft image cannot be restored", async () => {
    const image: JsonContent = {
      type: "imageAttachment",
      attrs: { b64content: "not-decodable" },
    };
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [draftRef(image)],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockRejectedValue(new Error("host unavailable"));

    await reopenClosedTab(router("/", undefined));

    expect(mocks.restoreClosedHeaderTabs).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    const toastCall = mocks.toastInfo.mock.calls.at(0);
    const toastOptions = toastCall?.[1];
    if (
      typeof toastOptions !== "object" ||
      toastOptions === null ||
      !("description" in toastOptions) ||
      typeof toastOptions.description !== "string"
    ) {
      throw new Error("expected a recovery toast description");
    }
    expect(toastOptions.description).toContain("kept");
    expect(useTabRecoveryHistory.getState().entries).toEqual([entry]);
  });

  it("restores available bulk items and retains only the failed draft", async () => {
    const image: JsonContent = {
      type: "imageAttachment",
      attrs: { b64content: "not-decodable" },
    };
    const failedDraft = draftRef(image);
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: true,
      items: [
        ...epicEntry({ id: "entry-1", bulk: true }).items,
        { ...draftRef(image, "draft-1"), index: 1 },
      ],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockRejectedValue(new Error("host unavailable"));

    await reopenClosedTab(router("/", undefined));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(useTabRecoveryHistory.getState().entries).toEqual([
      expect.objectContaining({
        id: "entry-1",
        items: [{ ...failedDraft, index: 1 }],
      }),
    ]);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    const toastCall = mocks.toastInfo.mock.calls.at(0);
    const toastOptions = toastCall?.[1];
    if (
      typeof toastOptions !== "object" ||
      toastOptions === null ||
      !("description" in toastOptions) ||
      typeof toastOptions.description !== "string"
    ) {
      throw new Error("expected a recovery toast description");
    }
    expect(toastOptions.description).toContain("kept");
  });

  it("focuses a single inner tab when already on its owning task", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: false });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    const navigateNestedFocus = vi.fn(
      (_epicId: string, _tabId: string, restore: PrepareNestedFocusTarget) =>
        restore(),
    );

    await reopenClosedTab(router("/epics/epic-1/tab-1", navigateNestedFocus));

    expect(navigateNestedFocus).toHaveBeenCalledTimes(1);
    expect(mocks.canvasState.restoreCanvasForRecovery).toHaveBeenCalledWith(
      "tab-1",
      {
        before: entry.before,
        after: entry.after,
        instanceIds: [SPEC_A.instanceId],
        paneIds: [],
        focus: true,
      },
    );
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("blurs the pane opener before a single inner-tab restore", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: false });
    const opener = mountInput("pane-opener");
    opener.focus();
    let activeElementAtRestore: Element | null = null;
    mocks.canvasState.restoreCanvasForRecovery.mockImplementation(() => {
      activeElementAtRestore = document.activeElement;
    });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/other/other-tab", undefined));

    expect(activeElementAtRestore).toBe(document.body);
    expect(document.activeElement).not.toBe(opener);
  });

  it("keeps focus for a bulk inner-tab restore on the current task", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: true });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    const navigateNestedFocus = vi.fn();

    await reopenClosedTab(router("/epics/epic-1/tab-1", navigateNestedFocus));

    expect(navigateNestedFocus).not.toHaveBeenCalled();
    expect(mocks.canvasState.restoreCanvasForRecovery).toHaveBeenCalledWith(
      "tab-1",
      {
        before: entry.before,
        after: entry.after,
        instanceIds: [SPEC_A.instanceId],
        paneIds: [],
        focus: false,
      },
    );
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("keeps the pane opener focused for a bulk same-task restore", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: true });
    const opener = mountInput("pane-opener");
    opener.parentElement?.setAttribute("data-group-id", "pane-1");
    opener.focus();
    let activeElementAtRestore: Element | null = null;
    mocks.canvasState.restoreCanvasForRecovery.mockImplementation(() => {
      activeElementAtRestore = document.activeElement;
    });
    mocks.canvasState.canvasByTabId["tab-1"] = {
      ...EMPTY_CANVAS,
      activePaneId: "pane-1",
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/epic-1/tab-1", undefined));
    await nextAnimationFrame();

    expect(activeElementAtRestore).toBe(document.body);
    expect(document.activeElement).toBe(opener);
  });

  it("does not reclaim focus after the user focuses elsewhere during bulk restore", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: true });
    const opener = mountInput("pane-opener");
    opener.parentElement?.setAttribute("data-group-id", "pane-1");
    const unrelatedInput = mountInput(null);
    opener.focus();
    mocks.canvasState.canvasByTabId["tab-1"] = {
      ...EMPTY_CANVAS,
      activePaneId: "pane-1",
    };
    mocks.canvasState.restoreCanvasForRecovery.mockImplementation(() => {
      unrelatedInput.focus();
    });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/epic-1/tab-1", undefined));
    await nextAnimationFrame();

    expect(document.activeElement).toBe(unrelatedInput);
  });

  it("leaves an unrelated text input focused during a single restore", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: false });
    const unrelatedInput = mountInput(null);
    unrelatedInput.type = "text";
    unrelatedInput.focus();
    let activeElementAtRestore: Element | null = null;
    mocks.canvasState.restoreCanvasForRecovery.mockImplementation(() => {
      activeElementAtRestore = document.activeElement;
    });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/other/other-tab", undefined));

    expect(activeElementAtRestore).toBe(unrelatedInput);
    expect(document.activeElement).toBe(unrelatedInput);
  });

  it("navigates to a single inner tab when its task is elsewhere", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: false });
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/other/other-tab", undefined));

    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.canvasState.restoreCanvasForRecovery).toHaveBeenCalledWith(
      "tab-1",
      {
        before: entry.before,
        after: entry.after,
        instanceIds: [SPEC_A.instanceId],
        paneIds: [],
        focus: true,
      },
    );
  });

  it("restores a hidden task using its retained canvas instead of stale after state", async () => {
    const entry = canvasEntry({ id: "entry-1", bulk: true });
    const retained = canvasSnapshot([]);
    mocks.canvasState.canvasByTabId["tab-1"] = retained;
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/epics/epic-1/tab-1", undefined));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ canvas: retained })],
      null,
    );
    expect(mocks.restoreClosedHeaderTabs).not.toHaveBeenCalledWith(
      [expect.objectContaining({ canvas: entry.after })],
      null,
    );
  });

  it("does not restore a draft removed while its image is being prepared", async () => {
    const image: JsonContent = {
      type: "imageAttachment",
      attrs: { b64content: "pending" },
    };
    const entry: Extract<TabRecoveryEntry, { kind: "header" }> = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [draftRef(image)],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    let resolveDraft: (ready: boolean) => void = () => undefined;
    mocks.prepareSavedDraft.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDraft = resolve;
        }),
    );

    const reopen = reopenClosedTab(router("/", undefined));
    await Promise.resolve();
    expect(mocks.prepareSavedDraft).toHaveBeenCalledTimes(1);

    useTabRecoveryHistory.setState({ entries: [], ready: true });
    resolveDraft(true);
    await reopen;

    expect(mocks.restoreClosedHeaderTabs).not.toHaveBeenCalled();
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });
});
