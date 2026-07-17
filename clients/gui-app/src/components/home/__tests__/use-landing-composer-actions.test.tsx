import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import { epicDisplayTitle } from "@/lib/display-title";
import { createEpicName } from "@/lib/epic-name";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../__tests__/test-browser-apis";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const landingMocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  createTerminalAgent: vi.fn<(input: unknown) => Promise<void>>(),
  navigate: vi.fn(),
  getActiveHostId: vi.fn(() => "host-landing"),
  getRequestContextUserId: vi.fn<() => string | null>(() => "user-landing"),
  getActiveHost: vi.fn(() => ({
    hostId: "host-landing",
    label: "Local",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    status: "available",
  })),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => landingMocks.navigate,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => ({
    request: landingMocks.request,
    getActiveHostId: landingMocks.getActiveHostId,
    getActiveHost: landingMocks.getActiveHost,
    getRequestContextUserId: landingMocks.getRequestContextUserId,
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({
    create: landingMocks.createTerminalAgent,
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  imageHashKeys: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
}));

vi.mock("@/lib/composer/landing-image-store", () => ({
  sessionImageBytes: imageStoreMocks.sessionImageBytes,
  getImageBytes: imageStoreMocks.getImageBytes,
  imageHashKeys: imageStoreMocks.imageHashKeys,
}));

const SUBMITTED_PROMPT = "Plan the host chat bootstrap";
const WORKSPACE_PATH = "/tmp/traycer";
const DRAFT_WORKSPACE_PATH = "/tmp/draft-workspace";
const GLOBAL_WORKSPACE_PATH = "/tmp/global-workspace";
const UNKNOWN_WORKSPACE_PATH = "/tmp/unknown-workspace";

describe("useLandingComposerActions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    landingMocks.request.mockReset();
    landingMocks.createTerminalAgent.mockReset();
    landingMocks.navigate.mockReset();
    landingMocks.request.mockResolvedValue({ roomInfo: null });
    landingMocks.createTerminalAgent.mockResolvedValue(undefined);
    landingMocks.getActiveHostId.mockReset();
    landingMocks.getActiveHostId.mockReturnValue("host-landing");
    landingMocks.getActiveHost.mockReset();
    landingMocks.getActiveHost.mockReturnValue({
      hostId: "host-landing",
      label: "Local",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      status: "available",
    });
    vi.mocked(toast.error).mockClear();
    imageStoreMocks.sessionImageBytes.mockReset();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockReset();
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useSettingsStore.setState({
      defaultSelection: { harnessId: "codex", modelSlug: "", profileId: null },
      defaultPermission: "supervised",
      defaultReasoning: "high",
    });
  });

  afterEach(() => {
    cleanup();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  it("creates a folderless epic without a selected workspace folder", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [],
      workspaces: [],
      chat: {
        workspaceMode: "folderless",
        worktreeIntent: null,
      },
    });
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("refuses launch while a staged worktree path has unresolved metadata", () => {
    setSingleWorkspace();
    const key = { surface: "landing" as const, draftId: null };
    useWorktreeIntentStagingStore.getState().stageIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat-unresolved",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(key, [WORKSPACE_PATH]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey["landing:"],
    ).toBeDefined();
    queryClient.clear();
  });

  it("threads a non-ambient profileId into the initial chat message's run settings", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: {
          ...defaultToolbar(),
          selection: {
            ...defaultToolbar().selection,
            profileId: "work-profile",
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // `finalizeSubmission` writes the emitted settings to the sticky
    // run-settings store unconditionally (independent of the initial-message
    // path, which needs a signed-in profile this suite doesn't mock).
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings?.profileId,
    ).toBe("work-profile");

    queryClient.clear();
  });

  it("creates a folderless terminal-agent epic without a selected workspace folder", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.selectTerminalAgent({
        harnessId: "claude",
        agentMode: "regular",
        model: null,
        reasoningEffort: null,
        terminalAgentArgs: "",
        profileId: null,
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    });
    expect(landingMocks.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceMode: "folderless",
        worktreeIntent: null,
      }),
    );
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("threads a non-ambient profileId into the terminal-agent create call", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.selectTerminalAgent({
        harnessId: "claude",
        agentMode: "regular",
        model: null,
        reasoningEffort: null,
        terminalAgentArgs: "",
        profileId: "work-profile",
      });
    });

    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });
    expect(landingMocks.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "work-profile" }),
    );

    queryClient.clear();
  });

  it("blocks epic creation while the model slug is unresolved", () => {
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: {
          ...defaultToolbar(),
          selection: { harnessId: "codex", modelSlug: "", profileId: null },
        },
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);

    queryClient.clear();
  });

  it("creates an epic with workspace paths and repo identifiers, then navigates", async () => {
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    // Chat epics store an empty `title` (`""`) at create - the prompt is the
    // display-derivation source, carried on `initialUserPrompt`, not baked into
    // the stored title.
    expect(createEpicCall?.[1]).toMatchObject({
      epic: { title: "", initialUserPrompt: SUBMITTED_PROMPT },
      repoIdentifiers: [{ owner: "traycerai", repo: "traycer" }],
      workspaces: [{ workspacePath: WORKSPACE_PATH }],
    });

    await waitFor(() => {
      expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    });

    const tabIds = useEpicCanvasStore.getState().openTabOrder;
    expect(tabIds).toHaveLength(1);
    const firstTab = useEpicCanvasStore.getState().tabsById[tabIds[0]];
    if (firstTab === undefined) throw new Error("expected created tab");
    // The tab carries the RAW empty title; the prompt slice is derived at render
    // via `epicDisplayTitle`, never persisted into the tab `name`.
    expect(firstTab.name).toBe("");
    expect(
      epicDisplayTitle({
        title: firstTab.name,
        initialUserPrompt: SUBMITTED_PROMPT,
      }),
    ).toBe(createEpicName(SUBMITTED_PROMPT));
    const expectedSettings = {
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toEqual(expectedSettings);
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings(firstTab.epicId),
    ).toEqual(expectedSettings);

    queryClient.clear();
  });

  it("re-inlines a same-session image synchronously and keeps navigation sync", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForHashImage("hash-same-session", "look here"),
        toolbar: defaultToolbar(),
      });
    });

    // The session fast path resolves bytes without an await, so navigation fires
    // synchronously inside the act() and IndexedDB is never read.
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(imageStoreMocks.getImageBytes).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    const imageNode = submittedImageNodeFromHandoff();
    expect(imageNode.attrs?.b64content).toBe(HELLO_BASE64);
    expect(imageNode.attrs?.hash).toBeNull();

    queryClient.clear();
  });

  it("awaits IndexedDB for a restored (session-cold) image before sending", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForHashImage("hash-restored", "restored draft"),
        toolbar: defaultToolbar(),
      });
    });

    // Cold cache → the optimistic block waits on the async IndexedDB read; nothing
    // has navigated yet on the synchronous tick.
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    });
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith("hash-restored");

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    const imageNode = submittedImageNodeFromHandoff();
    expect(imageNode.attrs?.b64content).toBe(HELLO_BASE64);
    expect(imageNode.attrs?.hash).toBeNull();

    queryClient.clear();
  });

  it("blocks the send with a toast when an image's bytes are missing", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForHashImage("hash-missing", "wiped image"),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach an image.", {
        description: "Re-add the image and try sending again.",
      });
    });
    // The send is aborted: no navigation, no epic created.
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
    ).toBe(false);

    queryClient.clear();
  });

  it("surfaces a toast and aborts the send when the IndexedDB read rejects", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockRejectedValue(
      new Error("idb unavailable"),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForHashImage("hash-error", "unreadable image"),
        toolbar: defaultToolbar(),
      });
    });

    // The rejected read is caught (no unhandled rejection) and surfaced; without
    // the `.catch` the toast never fires and the failure is silent.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach an image.", {
        description: "Image storage is unavailable. Please try again.",
      });
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
    ).toBe(false);

    queryClient.clear();
  });

  it("guards a double submit while a restored image resolves (creates one epic)", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    // Two synchronous submits before the async IndexedDB read resolves. The second
    // hits the in-flight guard; without it, both would resolve and finalize → two
    // epics.
    act(() => {
      const editor = editorHandleForHashImage(
        "hash-restored",
        "restored draft",
      );
      result.current.submit({ editor, toolbar: defaultToolbar() });
      result.current.submit({ editor, toolbar: defaultToolbar() });
    });

    await waitFor(() => {
      expect(landingMocks.navigate).toHaveBeenCalled();
    });
    // Let any second (unguarded) dispatch flush before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      landingMocks.request.mock.calls.filter((c) => c[0] === "epic.create"),
    ).toHaveLength(1);
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });

  it("marks the first valid optimistic workspace binding as primary", async () => {
    useWorkspaceFoldersStore.setState({
      folders: [UNKNOWN_WORKSPACE_PATH, WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const seededBindings = queryClient.getQueriesData<{
      readonly rows: ReadonlyArray<{
        readonly runningDir: string;
        readonly isPrimary: boolean;
      }>;
    }>({
      queryKey: hostQueryKeys.methodScope(
        "host-landing",
        "worktree.listBindingsForEpic",
      ),
    });
    expect(seededBindings.map(([, data]) => data?.rows)).toEqual([
      [
        expect.objectContaining({
          runningDir: WORKSPACE_PATH,
          isPrimary: true,
        }),
      ],
    ]);

    queryClient.clear();
  });

  it("emits associations primary-first and restamps the outgoing intent when the explicit primary isn't the first folder", async () => {
    const SECOND_PATH = "/tmp/second-workspace";
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_PATH, SECOND_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
        [SECOND_PATH]: {
          path: SECOND_PATH,
          name: "second",
          repoIdentifier: null,
        },
      },
      // The user explicitly switched primary to the SECOND folder.
      primaryPath: SECOND_PATH,
    });
    // The staged intent still carries a STALE primary bit on the first
    // folder (staged before the switch) - launch must restamp it by path.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", draftId: null },
      {
        entries: [
          {
            kind: "local",
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: true,
          },
          {
            kind: "local",
            workspacePath: SECOND_PATH,
            repoIdentifier: null,
            isPrimary: false,
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    // Associations are emitted primary-first for the legacy order-sensitive
    // host creation; picker display order is untouched (store still holds
    // [first, second]).
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [
        { workspacePath: SECOND_PATH },
        { workspacePath: WORKSPACE_PATH },
      ],
      chat: {
        worktreeIntent: {
          entries: [
            expect.objectContaining({
              workspacePath: WORKSPACE_PATH,
              isPrimary: false,
            }),
            expect.objectContaining({
              workspacePath: SECOND_PATH,
              isPrimary: true,
            }),
          ],
        },
      },
    });
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      WORKSPACE_PATH,
      SECOND_PATH,
    ]);

    queryClient.clear();
  });

  it("never lets a ghost folder from corrupt persisted state reach the launch payload or intent restamp", async () => {
    // The reviewer's corrupt-persistence scenario, end to end: a persisted
    // payload whose folder array carries a ghost path with no metadata, a
    // staged intent still naming that ghost as primary - after rehydration
    // + submit, neither the associations nor the intent may carry the ghost,
    // and the real folder must be the (single) primary.
    window.localStorage.setItem(
      "traycer-gui-app:workspace-folders",
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/tmp/ghost", WORKSPACE_PATH],
          folderInfoByPath: {
            [WORKSPACE_PATH]: {
              path: WORKSPACE_PATH,
              name: "traycer",
              repoIdentifier: { owner: "traycerai", repo: "traycer" },
            },
          },
          primaryPath: "/tmp/ghost",
        },
      }),
    );
    await useWorkspaceFoldersStore.persist.rehydrate();
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", draftId: null },
      {
        entries: [
          {
            kind: "local",
            workspacePath: "/tmp/ghost",
            repoIdentifier: null,
            isPrimary: true,
          },
          {
            kind: "local",
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: false,
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [{ workspacePath: WORKSPACE_PATH }],
      chat: {
        worktreeIntent: {
          entries: [
            expect.objectContaining({
              workspacePath: WORKSPACE_PATH,
              isPrimary: true,
            }),
          ],
        },
      },
    });

    queryClient.clear();
  });

  it("synthesizes a local entry for a NON-GIT primary that was never staged, instead of launching with zero primaries", async () => {
    // The mixed git/non-git regression. Only git folders are ever auto-staged
    // (the seeding effect iterates git summaries), so a non-git folder has NO
    // staged entry. Promoting it to primary restamps the only staged (git)
    // entry to `isPrimary: false` and has nothing to promote in its place -
    // so the launch boundary MUST synthesize a `local` entry for it, or the
    // outgoing intent carries zero primaries.
    const NON_GIT_PATH = "/tmp/non-git-workspace";
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_PATH, NON_GIT_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
        [NON_GIT_PATH]: {
          path: NON_GIT_PATH,
          name: "non-git",
          repoIdentifier: null,
        },
      },
      // The user clicked the pin on the NON-GIT folder.
      primaryPath: NON_GIT_PATH,
    });
    // What `setPrimaryFolder`'s restamp actually leaves behind: the git
    // folder's worktree entry, demoted, and no entry at all for the non-git
    // folder it was demoted in favour of.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", draftId: null },
      {
        entries: [
          {
            kind: "worktree",
            scripts: null,
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: false,
            branch: {
              type: "new",
              name: "traycer/feature",
              source: "main",
              carryUncommittedChanges: false,
            },
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [
        { workspacePath: NON_GIT_PATH },
        { workspacePath: WORKSPACE_PATH },
      ],
      chat: {
        worktreeIntent: {
          // Entries follow workspace order. The git folder survives its
          // demotion with its branch selection intact, and the non-git folder
          // gains a synthesized `local` entry carrying the primary flag - so
          // the set holds EXACTLY ONE primary (`toMatchObject` pins the array
          // length, so a third entry or a second primary fails here).
          entries: [
            expect.objectContaining({
              kind: "worktree",
              workspacePath: WORKSPACE_PATH,
              isPrimary: false,
              // The demoted git folder keeps its branch selection intact -
              // demotion restamps `isPrimary`, it never rebuilds the entry.
              branch: {
                type: "new",
                name: "traycer/feature",
                source: "main",
                carryUncommittedChanges: false,
              },
            }),
            expect.objectContaining({
              kind: "local",
              workspacePath: NON_GIT_PATH,
              repoIdentifier: null,
              isPrimary: true,
            }),
          ],
        },
      },
    });

    queryClient.clear();
  });

  it("clears pre-seeded epic settings when epic creation fails", async () => {
    landingMocks.request.mockRejectedValue(new Error("create failed"));
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    await waitFor(() => {
      const tabId = useEpicCanvasStore.getState().openTabOrder.at(0);
      if (tabId === undefined) throw new Error("expected optimistic tab");
      const epicId = useEpicCanvasStore.getState().tabsById[tabId]?.epicId;
      if (epicId === undefined) throw new Error("expected optimistic epic");
      expect(
        useComposerRunSettingsStore.getState().getEpicRunSettings(epicId),
      ).toBeNull();
    });
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toEqual({
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });

    queryClient.clear();
  });

  it("creates an epic from the active draft workspace instead of the global workspace", async () => {
    useWorkspaceFoldersStore.setState({
      folders: [DRAFT_WORKSPACE_PATH],
      folderInfoByPath: {
        [DRAFT_WORKSPACE_PATH]: {
          path: DRAFT_WORKSPACE_PATH,
          name: "draft-workspace",
          repoIdentifier: { owner: "traycerai", repo: "draft-workspace" },
        },
      },
    });
    useLandingDraftStore.getState().createDraft(null);
    useWorkspaceFoldersStore.setState({
      folders: [GLOBAL_WORKSPACE_PATH],
      folderInfoByPath: {
        [GLOBAL_WORKSPACE_PATH]: {
          path: GLOBAL_WORKSPACE_PATH,
          name: "global-workspace",
          repoIdentifier: { owner: "traycerai", repo: "global-workspace" },
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [{ owner: "traycerai", repo: "draft-workspace" }],
      workspaces: [{ workspacePath: DRAFT_WORKSPACE_PATH }],
    });
    expect(JSON.stringify(createEpicCall?.[1])).not.toContain(
      GLOBAL_WORKSPACE_PATH,
    );

    queryClient.clear();
  });
});

function queryClientWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function QueryClientWrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function defaultToolbar() {
  return {
    selection: {
      harnessId: "codex" as const,
      modelSlug: "gpt-5-codex",
      profileId: null,
    },
    reasoning: "high" as const,
    serviceTier: "" as const,
    permission: "supervised" as const,
    agentMode: "regular" as const,
  };
}

function editorHandleForPrompt(prompt: string): ComposerPromptEditorHandle {
  const content = jsonContentForPrompt(prompt);
  return {
    isReady: () => true,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => prompt.length === 0,
    clear: () => undefined,
    setContent: () => undefined,
    insertImageAttachments: () => undefined,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function jsonContentForPrompt(prompt: string): JsonContent {
  if (prompt.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
}

// A hash-only image draft (an `imageAttachment` node carrying a `hash`, never
// `b64content`) plus a line of text — the shape the live landing editor produces
// after T4.
function editorHandleForHashImage(
  hash: string,
  prompt: string,
): ComposerPromptEditorHandle {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              hash,
              mimeType: "image/png",
              size: 5,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  return {
    ...editorHandleForPrompt(prompt),
    getJSON: () => content,
  };
}

function findImageNode(node: JsonContent): JsonContent | null {
  if (node.type === "imageAttachment") return node;
  for (const child of node.content ?? []) {
    const found = findImageNode(child);
    if (found !== null) return found;
  }
  return null;
}

// The re-inlined content lands in the initial-chat handoff store synchronously
// in `finalizeSubmission` (before the host round-trip), which is the canonical
// source of the submitted content regardless of whether `initialMessage` is
// folded in (that depends on an auth profile the test doesn't seed).
function submittedImageNodeFromHandoff(): JsonContent {
  const handoffs = Object.values(
    useInitialChatHandoffStore.getState().handoffs,
  );
  if (handoffs.length !== 1) {
    throw new Error(`expected exactly one handoff, got ${handoffs.length}`);
  }
  const imageNode = findImageNode(handoffs[0].content);
  if (imageNode === null) throw new Error("expected an image node in content");
  return imageNode;
}

const HELLO_BYTES = new Uint8Array([104, 101, 108, 108, 111]);
const HELLO_BASE64 = "aGVsbG8=";

function setSingleWorkspace(): void {
  useWorkspaceFoldersStore.setState({
    folders: [WORKSPACE_PATH],
    folderInfoByPath: {
      [WORKSPACE_PATH]: {
        path: WORKSPACE_PATH,
        name: "traycer",
        repoIdentifier: { owner: "traycerai", repo: "traycer" },
      },
    },
  });
}
