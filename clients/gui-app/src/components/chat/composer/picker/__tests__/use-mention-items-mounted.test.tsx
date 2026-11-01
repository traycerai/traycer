import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "@/lib/composer/types";
import type { MentionFlowStep } from "@/lib/composer/mentions";
import type { UseEpicMentionEntriesParams } from "@/hooks/composer/use-epic-mention-entries";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  EMPTY_CHATS_SLICE,
  EMPTY_TERMINAL_AGENTS_SLICE,
  type ArtifactProjection,
} from "@/stores/epics/open-epic/types";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../composer-picker-store";
import {
  useMentionItems,
  type UseMentionItemsParams,
} from "../use-mention-items";

interface WorkspaceResult {
  readonly data: ReadonlyArray<WorkspaceEntry>;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: null;
}

const workspaceMock = vi.hoisted((): { result: WorkspaceResult } => ({
  result: {
    data: [],
    isLoading: false,
    isFetching: false,
    error: null,
  },
}));

const hostSupportMock = vi.hoisted(() => ({ supportsArtifactIndex: false }));

// The picker reads `handle.store.getState()` and nothing else of the handle,
// so the fixture carries just the store.
type OpenEpicStoreOnlyHandle = Pick<OpenEpicStoreHandle, "store">;

const epicHandleMock = vi.hoisted(
  (): { handle: OpenEpicStoreOnlyHandle | null } => ({ handle: null }),
);

const stableMocks = vi.hoisted(() => {
  const githubContext = {
    pullRequests: { rows: [], rowsHeld: false, repositories: null },
    issues: { rows: [], rowsHeld: false, repositories: null },
    supported: false,
    now: 0,
  };
  return {
    epicMentionResult: {
      data: [],
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    },
    // Records the requests the picker hands the epic mention lane.
    epicMentionRequests: [] as UseEpicMentionEntriesParams["requests"][],
    githubResult: {
      context: githubContext,
      chrome: null,
      loading: false,
      checking: false,
      errored: false,
    },
    cloudTasksResult: { tasks: [] },
    worktreeResult: { rows: [] },
    terminalResult: {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
    },
    hostReadiness: {
      hostId: null,
      requestContextUserId: null,
      isReady: false,
      hasRpcEndpoint: false,
      canExecute: false,
    },
    hostDirectory: { findById: (): null => null },
    browserCoordinators: [],
    unsubscribeBrowserSessions: (): void => undefined,
    authState: { status: "signed-out" },
  };
});

// A terminal's task directory is named by its host's directory row; this
// suite has no host directory and no task terminal in the task's own folder.
vi.mock("@/hooks/terminal/use-task-home-directory", () => ({
  useTaskHomeDirectory: () => null,
  useTaskHomeDirectoryFor: () => () => null,
}));
vi.mock("@/hooks/composer/use-workspace-entries", () => ({
  useWorkspaceEntries: (): WorkspaceResult => workspaceMock.result,
}));

vi.mock("@/hooks/composer/use-epic-mention-entries", () => ({
  useEpicMentionEntries: (params: UseEpicMentionEntriesParams) => {
    stableMocks.epicMentionRequests.push(params.requests);
    return stableMocks.epicMentionResult;
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (): boolean => hostSupportMock.supportsArtifactIndex,
}));

vi.mock("../use-github-mention-sections", () => ({
  useGithubMentionSections: () => stableMocks.githubResult,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => stableMocks.cloudTasksResult,
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpicForClient: () => stableMocks.worktreeResult,
}));

vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => stableMocks.terminalResult,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => stableMocks.hostReadiness,
}));

vi.mock("@/hooks/ui/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T): T => value,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => epicHandleMock.handle,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  authorizesCloudCapability: (status: string): boolean =>
    status === "signed-in",
  useAuthStore: Object.assign(
    <T,>(selector: (state: { status: string }) => T): T =>
      selector(stableMocks.authState),
    {
      getState: () => stableMocks.authState,
      subscribe: () => () => undefined,
    },
  ),
}));

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => stableMocks.hostDirectory,
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  browserSessionsCoordinatorsForEpic: () => stableMocks.browserCoordinators,
  subscribeToBrowserSessionsCoordinators: () =>
    stableMocks.unsubscribeBrowserSessions,
}));

function fileEntry(id: string, label: string, root: string): WorkspaceEntry {
  return {
    kind: "file",
    id,
    label,
    relPath: label,
    absolutePath: `${root}/${label}`,
    workspacePath: root,
    description: "",
  };
}

function setWorkspaceResult(
  data: ReadonlyArray<WorkspaceEntry>,
  flags: { readonly isLoading: boolean; readonly isFetching: boolean },
): void {
  workspaceMock.result = {
    data,
    isLoading: flags.isLoading,
    isFetching: flags.isFetching,
    error: null,
  };
}

function openMention(
  store: ComposerPickerStore,
  sessionId: number,
  query: string,
): void {
  store.getState().openPicker({
    sessionId,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 0, to: query.length + 1 },
    query,
    commit: vi.fn(),
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
}

const ARTIFACTS_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "artifacts",
  stepId: "root",
  workspacePath: null,
};

const MARKDOWN_ARTIFACT_METHODS = [
  "epic.mentionSpecs",
  "epic.mentionTickets",
  "epic.mentionStories",
  "epic.mentionReviews",
];

const FILE_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "files",
  stepId: "root",
  workspacePath: null,
};

function StrictWrapper(props: { readonly children: ReactNode }): ReactNode {
  return <StrictMode>{props.children}</StrictMode>;
}

function renderMentionItems(
  pickerStore: ComposerPickerStore,
  currentEpicId: string | null,
) {
  const params: UseMentionItemsParams = {
    pickerStore,
    hostClient: null,
    mentionRoots: ["/repo"],
    currentEpicId,
  };
  return renderHook(() => useMentionItems(params), {
    wrapper: StrictWrapper,
  });
}

function localArtifact(
  id: string,
  kind: ArtifactProjection["kind"],
): ArtifactProjection {
  return {
    id,
    kind,
    title: id,
    folderName: id,
    parentId: null,
    artifactRoomId: null,
    createdAt: 1,
    updatedAt: 1,
    status: null,
    createdManually: false,
  };
}

function openEpicHandleHoldingArtifacts(
  artifacts: ReadonlyArray<ArtifactProjection>,
): OpenEpicStoreOnlyHandle {
  const state = {
    chats: EMPTY_CHATS_SLICE,
    tuiAgents: EMPTY_TERMINAL_AGENTS_SLICE,
    artifacts: {
      byId: Object.fromEntries(
        artifacts.map((artifact) => [artifact.id, artifact]),
      ),
      allIds: artifacts.map((artifact) => artifact.id),
    },
    epic: { title: "Epic" },
  };
  // Same shape `tab-strip.test.tsx` gives its handle stores: the slice of the
  // Zustand store API the consumer reads, typed through `unknown`.
  const storeBase: unknown = {
    getState: () => state,
    subscribe: () => () => undefined,
  };
  return { store: storeBase as OpenEpicStoreHandle["store"] };
}

afterEach(() => {
  cleanup();
  stableMocks.epicMentionRequests.length = 0;
  stableMocks.authState.status = "signed-out";
  hostSupportMock.supportsArtifactIndex = false;
  epicHandleMock.handle = null;
  setWorkspaceResult([], { isLoading: false, isFetching: false });
});

describe("useMentionItems mounted publication", () => {
  it("publishes a fresh non-empty @config result during a background refetch, including StrictMode", async () => {
    const rows = [fileEntry("file:config", "config.ts", "/repo")];
    setWorkspaceResult(rows, { isLoading: false, isFetching: true });
    const pickerStore = createComposerPickerStore();
    openMention(pickerStore, 1, "config");

    renderMentionItems(pickerStore, null);

    await waitFor(() => {
      expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
        "file:config",
      ]);
    });
    expect(pickerStore.getState().itemsForQuery).toBe("config");
    expect(pickerStore.getState().itemsForStepId).toBe("root");
  });

  it("keeps the prior query visible but uncommittable until settled rows publish, then commits the new query", async () => {
    const firstRows = [fileEntry("file:config", "config.ts", "/repo")];
    const settledRows = [
      fileEntry("file:configuration", "configuration.ts", "/repo"),
    ];
    setWorkspaceResult(firstRows, { isLoading: false, isFetching: false });
    const pickerStore = createComposerPickerStore();
    openMention(pickerStore, 1, "config");
    const mounted = renderMentionItems(pickerStore, null);

    await waitFor(() => {
      expect(pickerStore.getState().itemsForQuery).toBe("config");
    });

    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("expected a picker commit callback");
    const commitSpy = vi.fn(commit);
    pickerStore.setState({ commit: commitSpy });

    act(() => {
      setWorkspaceResult(firstRows, { isLoading: false, isFetching: true });
      pickerStore.getState().updateRange({
        sessionId: 1,
        range: { from: 0, to: 6 },
        query: "configu",
        slashScope: null,
        clientRect: null,
      });
      mounted.rerender();
    });

    expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
      "file:config",
    ]);
    expect(pickerStore.getState().itemsForQuery).toBe("config");
    expect(pickerStore.getState().commitActiveItem()).toBe(false);
    expect(commitSpy).not.toHaveBeenCalled();

    act(() => {
      setWorkspaceResult(settledRows, { isLoading: false, isFetching: false });
      mounted.rerender();
    });

    await waitFor(() => {
      expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
        "file:configuration",
      ]);
    });
    expect(pickerStore.getState().itemsForQuery).toBe("configu");
    expect(pickerStore.getState().commitActiveItem()).toBe(true);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes fresh rows after a session reset and after a step reset", async () => {
    const sessionOneRows = [fileEntry("file:one", "config.one.ts", "/repo")];
    const providerRows = [
      fileEntry("file:provider", "config.provider.ts", "/repo"),
    ];
    const sessionTwoRows = [fileEntry("file:two", "config.two.ts", "/repo")];
    setWorkspaceResult(sessionOneRows, { isLoading: false, isFetching: true });
    const pickerStore = createComposerPickerStore();
    openMention(pickerStore, 1, "config");
    const mounted = renderMentionItems(pickerStore, null);

    await waitFor(() => {
      expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
        "file:one",
      ]);
    });

    act(() => {
      setWorkspaceResult(providerRows, {
        isLoading: false,
        isFetching: true,
      });
      pickerStore.getState().setStep(FILE_STEP);
      mounted.rerender();
    });

    await waitFor(() => {
      expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
        "mention-back",
        "file:provider",
      ]);
    });

    act(() => {
      setWorkspaceResult([fileEntry("file:root", "config.root.ts", "/repo")], {
        isLoading: false,
        isFetching: true,
      });
      pickerStore.getState().setStep({ kind: "root" });
      mounted.rerender();
    });
    expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
      "file:root",
    ]);
    expect(pickerStore.getState().itemsForStepId).toBe("root");

    act(() => {
      setWorkspaceResult(sessionTwoRows, {
        isLoading: false,
        isFetching: true,
      });
      openMention(pickerStore, 2, "config");
      mounted.rerender();
    });

    expect(pickerStore.getState().items.map((item) => item.id)).toEqual([
      "file:two",
    ]);
    expect(pickerStore.getState().itemsForQuery).toBe("config");
    expect(pickerStore.getState().itemsForStepId).toBe("root");
  });

  it("asks for html, canvas and file rows only when the host advertises epic.mentionArtifacts", () => {
    stableMocks.authState.status = "signed-in";

    function requestedMethodsOnArtifactsStep(
      supportsArtifactIndex: boolean,
    ): ReadonlyArray<string> {
      stableMocks.epicMentionRequests.length = 0;
      hostSupportMock.supportsArtifactIndex = supportsArtifactIndex;
      const pickerStore = createComposerPickerStore();
      openMention(pickerStore, 1, "");
      pickerStore.getState().setStep(ARTIFACTS_STEP);
      renderMentionItems(pickerStore, null);
      cleanup();
      const latestRequests = stableMocks.epicMentionRequests.at(-1);
      if (latestRequests === undefined) throw new Error("no epic requests");
      return latestRequests.map((request) => request.method);
    }

    expect(requestedMethodsOnArtifactsStep(false)).toEqual(
      MARKDOWN_ARTIFACT_METHODS,
    );
    expect(requestedMethodsOnArtifactsStep(true)).toEqual([
      ...MARKDOWN_ARTIFACT_METHODS,
      "epic.mentionArtifacts",
    ]);
  });

  it("offers the current epic's html, canvas and file artifacts only when the host advertises epic.mentionArtifacts", async () => {
    stableMocks.authState.status = "signed-in";
    const epicId = "epic-1";
    epicHandleMock.handle = openEpicHandleHoldingArtifacts([
      localArtifact("spec-1", "spec"),
      localArtifact("canvas-1", "canvas"),
    ]);

    async function offeredArtifactIds(
      supportsArtifactIndex: boolean,
    ): Promise<ReadonlyArray<string>> {
      hostSupportMock.supportsArtifactIndex = supportsArtifactIndex;
      const pickerStore = createComposerPickerStore();
      openMention(pickerStore, 1, "");
      pickerStore.getState().setStep(ARTIFACTS_STEP);
      renderMentionItems(pickerStore, epicId);
      await waitFor(() => {
        expect(pickerStore.getState().itemsForStepId).toBe("artifacts:root:");
      });
      const offered = pickerStore
        .getState()
        .items.map((item) => item.id)
        .filter((id) => id !== "mention-back");
      cleanup();
      return offered;
    }

    expect(await offeredArtifactIds(false)).toEqual(["spec:epic-1:spec-1"]);
    expect(await offeredArtifactIds(true)).toEqual([
      "spec:epic-1:spec-1",
      "canvas:epic-1:canvas-1",
    ]);
  });
});
