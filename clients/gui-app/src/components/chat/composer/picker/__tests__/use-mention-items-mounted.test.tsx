import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "@/lib/composer/types";
import type { MentionFlowStep } from "@/lib/composer/mentions";
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

vi.mock("@/hooks/composer/use-workspace-entries", () => ({
  useWorkspaceEntries: (): WorkspaceResult => workspaceMock.result,
}));

vi.mock("@/hooks/composer/use-epic-mention-entries", () => ({
  useEpicMentionEntries: () => stableMocks.epicMentionResult,
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
  useMaybeOpenEpicHandle: () => null,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  authorizesCloudCapability: (status: string): boolean =>
    status === "signed-in",
  useAuthStore: <T,>(selector: (state: { status: string }) => T): T =>
    selector(stableMocks.authState),
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

const FILE_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "files",
  stepId: "root",
  workspacePath: null,
};

function StrictWrapper(props: { readonly children: ReactNode }): ReactNode {
  return <StrictMode>{props.children}</StrictMode>;
}

function renderMentionItems(pickerStore: ComposerPickerStore) {
  const params: UseMentionItemsParams = {
    pickerStore,
    hostClient: null,
    mentionRoots: ["/repo"],
    currentEpicId: null,
  };
  return renderHook(() => useMentionItems(params), {
    wrapper: StrictWrapper,
  });
}

afterEach(() => {
  cleanup();
  setWorkspaceResult([], { isLoading: false, isFetching: false });
});

describe("useMentionItems mounted publication", () => {
  it("publishes a fresh non-empty @config result during a background refetch, including StrictMode", async () => {
    const rows = [fileEntry("file:config", "config.ts", "/repo")];
    setWorkspaceResult(rows, { isLoading: false, isFetching: true });
    const pickerStore = createComposerPickerStore();
    openMention(pickerStore, 1, "config");

    renderMentionItems(pickerStore);

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
    const mounted = renderMentionItems(pickerStore);

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
    const mounted = renderMentionItems(pickerStore);

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
});
