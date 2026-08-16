import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import { epicDisplayTitle } from "@/lib/display-title";
import { createEpicName } from "@/lib/epic-name";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { tabItemId, type SplitStripItem } from "@/stores/tabs/layout";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

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
    transportDialability: "dialable",
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

// `landing-draft-store.ts` (real, unmocked - `createDraft` reads the global
// workspace snapshot through it) and `use-landing-composer-actions.ts` itself
// (the imperative "create draft" path) both resolve the per-host
// workspace-folder / run-settings buckets through this imperative snapshot,
// not through a hook. Left unmocked it falls back to the real (unbound)
// implementation, which always reports `null` - so every fixture below would
// seed a host bucket the code never reads. Pin it to the SAME host id
// `landingMocks.getActiveHostId()` returns, so the two ways this suite's
// production code resolves "the active host" agree.
vi.mock("@/lib/host/runtime", () => ({
  getHostBindingSnapshot: () => ({
    hostClient: { getActiveHostId: landingMocks.getActiveHostId },
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
    info: vi.fn(),
  },
}));

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  imageHashKeys: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  sessionHashKeys: vi.fn<() => ReadonlySet<string>>(() => new Set<string>()),
  deleteImage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  releaseSession: vi.fn(),
}));

vi.mock("@/lib/composer/landing-image-store", () => ({
  sessionImageBytes: imageStoreMocks.sessionImageBytes,
  getImageBytes: imageStoreMocks.getImageBytes,
  imageHashKeys: imageStoreMocks.imageHashKeys,
  sessionHashKeys: imageStoreMocks.sessionHashKeys,
  deleteImage: imageStoreMocks.deleteImage,
  releaseSession: imageStoreMocks.releaseSession,
}));

const SUBMITTED_PROMPT = "Plan the host chat bootstrap";

// The recorded RPC payload is `unknown` at this boundary, so the folded chat's
// id is narrowed structurally rather than asserted through a cast.
function foldedChatIdFromCreateEpicPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("chat" in payload)) return null;
  const chat = payload.chat;
  if (typeof chat !== "object" || chat === null) return null;
  if (!("chatId" in chat)) return null;
  const chatId = chat.chatId;
  return typeof chatId === "string" ? chatId : null;
}
const WORKSPACE_PATH = "/tmp/traycer";
const DRAFT_WORKSPACE_PATH = "/tmp/draft-workspace";
const GLOBAL_WORKSPACE_PATH = "/tmp/global-workspace";
const UNKNOWN_WORKSPACE_PATH = "/tmp/unknown-workspace";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Every workspace-folder / run-settings bucket in this suite is keyed by
// this host id, matching `landingMocks.getActiveHostId()`'s default return
// value - the same id `client.getActiveHostId()` resolves to via the mocked
// `@/lib/host` client.
const TEST_HOST_ID = "host-landing";

function setGlobalWorkspaceFolders(input: {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<
    Record<
      string,
      {
        readonly path: string;
        readonly name: string;
        readonly repoIdentifier: { owner: string; repo: string } | null;
        readonly hostId: string | null;
      }
    >
  >;
  readonly primaryPath?: string | null;
}): void {
  useWorkspaceFoldersStore.setState({
    byHost: {
      [TEST_HOST_ID]: {
        folders: input.folders,
        folderInfoByPath: input.folderInfoByPath,
        primaryPath: input.primaryPath ?? null,
      },
    },
  });
}

describe("useLandingComposerActions", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
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
      transportDialability: "dialable",
    });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    imageStoreMocks.sessionImageBytes.mockReset();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockReset();
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      stripOrder: [],
    });
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
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
    cleanup();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      stripOrder: [],
    });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  // Regression: consuming the landing session was gated on the SUBMITTING
  // host having an intent, so staging on host A and then submitting from a
  // folderless host B left A's slot alive - to seed the next landing session
  // (null draft) or linger against the staging cap (minted draft).
  it("consumes another host's staged pick even when the submitting host has none", async () => {
    const otherHostKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: "host-other",
      draftId: null,
    };
    useWorktreeIntentStagingStore.getState().setIntent(otherHostKey, {
      entries: [
        {
          kind: "local",
          workspacePath: "/elsewhere/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // The submitting host is folderless, so its own intent is null...
    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      chat: { worktreeIntent: null },
    });
    // ...and the other host's copy is still consumed with the session.
    await waitFor(() => {
      expect(
        useWorktreeIntentStagingStore.getState().intentByKey[
          worktreeStagingKeyString(otherHostKey)
        ],
      ).toBeUndefined();
    });

    queryClient.clear();
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(toast.error).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("folds the SAME chat id into epic.create that the launch handoff carries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // ONE MINT. The launch tab is opened around `handoff.chatId` (see
    // `initial-chat-handoff.test.tsx`, which asserts the eager-opened tile
    // carries exactly that id) and the chat itself is created by the folded
    // seed on this request - so if these two ids could ever diverge, the tab
    // would sit on a chat id that exists on no host and in no cloud row while
    // the real chat lived under the other one.
    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    const foldedChatId = foldedChatIdFromCreateEpicPayload(createEpicCall?.[1]);
    const handoff = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    ).at(0);
    expect(foldedChatId).not.toBeNull();
    expect(handoff?.chatId).toBe(foldedChatId);

    queryClient.clear();
  });

  it("refuses launch while a staged worktree path has unresolved metadata", () => {
    setSingleWorkspace();
    const key = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID)
        ?.profileId,
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
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        null,
      );
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
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: "work-profile",
        },
        null,
      );
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
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: {
          ...defaultToolbar(),
          selection: { harnessId: "codex", modelSlug: "", profileId: null },
        },
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
    ).toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);

    queryClient.clear();
  });

  it("creates an epic with workspace paths and repo identifiers, then navigates", async () => {
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();

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
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
    ).toEqual(expectedSettings);
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings(firstTab.epicId, TEST_HOST_ID),
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
        draftId: null,
        editor: editorHandleForHashImage("hash-same-session", "look here"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // The session fast path resolves bytes without an await, but placement waits
    // for the one-shot create response and never steals foreground focus.
    expect(landingMocks.navigate).not.toHaveBeenCalled();
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

  // The workspace context is read for the host active at submit; on the
  // session-cold image path an IndexedDB await separates that read from the
  // create, and `epic.create` dispatches to whichever host is active THEN.
  // Creating on B with A's paths would bind the epic to a machine the user
  // never composed against and file its remembered intent under a host that
  // will never read it.
  it("refuses to create when the active device changes mid-submission", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    const imageGate = deferred<Uint8Array | undefined>();
    imageStoreMocks.getImageBytes.mockReturnValue(imageGate.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-restored", "restored draft"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // The host moves while the IndexedDB read is in flight.
    landingMocks.getActiveHostId.mockReturnValue("host-switched");
    await act(async () => {
      imageGate.resolve(HELLO_BYTES);
      await imageGate.promise;
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create epic.",
        expect.objectContaining({
          description:
            "The active device changed while this was being prepared. Try again.",
        }),
      );
    });
    expect(
      landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
    ).toBe(false);

    landingMocks.getActiveHostId.mockReturnValue(TEST_HOST_ID);
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
        draftId: null,
        editor: editorHandleForHashImage("hash-restored", "restored draft"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // Cold cache → the optimistic block waits on the async IndexedDB read; nothing
    // has navigated yet on the synchronous tick.
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
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
        draftId: null,
        editor: editorHandleForHashImage("hash-missing", "wiped image"),
        slashCatalog: null,
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
        draftId: null,
        editor: editorHandleForHashImage("hash-error", "unreadable image"),
        slashCatalog: null,
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
      result.current.submit({
        draftId: null,
        editor,
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
      result.current.submit({
        draftId: null,
        editor,
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    // Let any second (unguarded) dispatch flush before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      landingMocks.request.mock.calls.filter((c) => c[0] === "epic.create"),
    ).toHaveLength(1);
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    // The guarded submit still STARTED an attempt before bailing, and each
    // `draftId: null` resolves to its own draft - so the guard has to settle
    // the attempt it is refusing. Otherwise that second draft keeps a composer
    // disabled forever with nothing left in flight to release it.
    const stillSubmitting = useLandingDraftStore
      .getState()
      .drafts.filter(
        (draft) =>
          draftRuntimeRegistry.getOrHydrate(draft.id)?.store.getState()
            .isSubmitting === true,
      );
    expect(stillSubmitting).toEqual([]);

    queryClient.clear();
  });

  it("marks the first valid optimistic workspace binding as primary", async () => {
    setGlobalWorkspaceFolders({
      folders: [UNKNOWN_WORKSPACE_PATH, WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH, SECOND_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
        [SECOND_PATH]: {
          path: SECOND_PATH,
          name: "second",
          repoIdentifier: null,
          hostId: TEST_HOST_ID,
        },
      },
      // The user explicitly switched primary to the SECOND folder.
      primaryPath: SECOND_PATH,
    });
    // The staged intent still carries a STALE primary bit on the first
    // folder (staged before the switch) - launch must restamp it by path.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
    expect(
      selectWorkspaceFoldersBucket(
        useWorkspaceFoldersStore.getState(),
        TEST_HOST_ID,
      ).folders,
    ).toEqual([WORKSPACE_PATH, SECOND_PATH]);

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
              hostId: TEST_HOST_ID,
            },
          },
          primaryPath: "/tmp/ghost",
        },
      }),
    );
    await useWorkspaceFoldersStore.persist.rehydrate();
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH, NON_GIT_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
        [NON_GIT_PATH]: {
          path: NON_GIT_PATH,
          name: "non-git",
          repoIdentifier: null,
          hostId: TEST_HOST_ID,
        },
      },
      // The user clicked the pin on the NON-GIT folder.
      primaryPath: NON_GIT_PATH,
    });
    // What `setPrimaryFolder`'s restamp actually leaves behind: the git
    // folder's worktree entry, demoted, and no entry at all for the non-git
    // folder it was demoted in favour of.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
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
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // T6 does not materialize a tab before the one-shot create succeeds, so a
    // rejected request leaves no optimistic result to clean up.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
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

  it("places a success after close once in the background without navigating", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-closing", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    expect(tabCommandCoordinator.closeRef(draftRef)).toBe(true);
    createGate.resolve({ roomInfo: null });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Epic created in the background.");
    queryClient.clear();
  });

  it("re-preflights a moved draft ref and replaces its current location", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-moving", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    // Another layout mutation moves the same ref; success must not revive the
    // captured original item id.
    useTabsStore.setState({
      items: [{ kind: "tab", id: "moved-draft-item", ref: draftRef }],
      activeItemId: "moved-draft-item",
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    createGate.resolve({ roomInfo: null });

    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "tab",
        ref: { kind: "epic" },
      });
    });
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("creates an epic from the active draft workspace instead of the global workspace", async () => {
    setGlobalWorkspaceFolders({
      folders: [DRAFT_WORKSPACE_PATH],
      folderInfoByPath: {
        [DRAFT_WORKSPACE_PATH]: {
          path: DRAFT_WORKSPACE_PATH,
          name: "draft-workspace",
          repoIdentifier: { owner: "traycerai", repo: "draft-workspace" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    setGlobalWorkspaceFolders({
      folders: [GLOBAL_WORKSPACE_PATH],
      folderInfoByPath: {
        [GLOBAL_WORKSPACE_PATH]: {
          path: GLOBAL_WORKSPACE_PATH,
          name: "global-workspace",
          repoIdentifier: { owner: "traycerai", repo: "global-workspace" },
          hostId: TEST_HOST_ID,
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
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
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

  it("retires a started create at identity teardown without opening, navigating, or updating its handoff", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-retired", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    const handoffBefore = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )[0];
    expect(handoffBefore.status).toBe("pending");

    draftRuntimeRegistry.teardown();
    createGate.resolve({ initialTurnStarted: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: tabItemId(draftRef), ref: draftRef },
    ]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    const handoffAfter = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )[0];
    expect(handoffAfter.status).toBe("pending");
    queryClient.clear();
  });

  it("retires a REJECTED create at identity teardown without marking its handoff failed", async () => {
    // The mirror of the test above on the failure arm. A late rejection after
    // teardown must not write `failed` back onto the torn-down identity: the
    // bridge has already moved on, so the next identity would inherit a
    // failure banner for a submission it never made.
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-retired-reject", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0].status,
    ).toBe("pending");

    draftRuntimeRegistry.teardown();
    createGate.reject(new Error("epic.create rejected after teardown"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0].status,
    ).toBe("pending");
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    queryClient.clear();
  });

  it("preserves a newer exact-draft snapshot and backgrounds the earlier create", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-post-intent-edit", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt("first request"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
    if (runtime === null) throw new Error("expected draft runtime");
    const newerContent = jsonContentForPrompt("newer unsent draft");
    runtime.setSnapshot(newerContent, null);
    runtime.flush();

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === draftId)?.content,
    ).toEqual(newerContent);
    expect(useTabsStore.getState().stripOrder).toEqual([draftRef]);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Epic created in the background.");
    queryClient.clear();
  });

  it("replaces the draft in place when only the caret moves after submit", async () => {
    // Under the event-driven contract, `setEditable(!disabled, false)` no
    // longer re-emits a document `update` on submit, and selection moves go
    // through `setSelection` (no contentRevision bump). A caret-only path
    // after submit must keep settlement current so the epic replaces the
    // draft tab in place - not a background tab with the sent prompt left
    // behind on the landing page.
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-editable-echo", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId,
        // A fresh object per `getJSON()` call, exactly like the real editor.
        editor: {
          ...editorHandleForPrompt(SUBMITTED_PROMPT),
          getJSON: () => jsonContentForPrompt(SUBMITTED_PROMPT),
        },
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });

    // Caret-only after submit - must not retire the placement.
    const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
    if (runtime === null) throw new Error("expected draft runtime");
    runtime.setSelection({ from: 2, to: 2 });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "tab",
        ref: { kind: "epic" },
      });
    });
    expect(useTabsStore.getState().items).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalledWith(
      "Epic created in the background.",
    );
    queryClient.clear();
  });

  it("keeps foreground suppressed when focus was acquired after submit intent", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "right")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "left")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    // Focus away and back after intent cannot retroactively grant ownership.
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "right")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "left")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        left: { kind: "tab", ref: { kind: "epic" } },
        right: { kind: "tab", ref: refB },
        focusedSide: "left",
      });
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("replaces a moved draft in its current split side without disturbing its partner or focus", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-move-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-move-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("move-split", refA, refB, "left")],
      activeItemId: "move-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    useTabsStore.setState({
      items: [splitItem("move-split", refB, refA, "right")],
      activeItemId: "move-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refB, refA],
    });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        id: "move-split",
        left: { kind: "tab", ref: refB },
        right: { kind: "tab", ref: { kind: "epic" } },
        focusedSide: "right",
        routeBackingSide: "right",
      });
    });
    expect(useTabsStore.getState().stripOrder).toEqual([
      refB,
      expect.objectContaining({ kind: "epic" }),
    ]);
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("settles simultaneous exact-draft submissions in their own split members and preserves newer focus", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-dual-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-dual-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("dual-split", refA, refB, "left")],
      activeItemId: "dual-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const firstCreate = deferred<unknown>();
    const secondCreate = deferred<unknown>();
    let createCount = 0;
    landingMocks.request.mockImplementation((method) => {
      if (method !== "epic.create") return Promise.resolve({});
      createCount += 1;
      return createCount === 1 ? firstCreate.promise : secondCreate.promise;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt("submit A"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => expect(createCount).toBe(1));
    useTabsStore.setState({
      items: [splitItem("dual-split", refA, refB, "right")],
      activeItemId: "dual-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    act(() => {
      result.current.submit({
        draftId: draftB,
        editor: editorHandleForPrompt("submit B"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => expect(createCount).toBe(2));

    firstCreate.resolve({ roomInfo: null });
    secondCreate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        left: { kind: "tab", ref: { kind: "epic" } },
        right: { kind: "tab", ref: { kind: "epic" } },
        focusedSide: "right",
      });
    });
    expect(useTabsStore.getState().activeItemId).toBe("dual-split");
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("uses the caller's terminal-agent draft in an A/B split, not the active sibling", async () => {
    setWorkspace("/tmp/terminal-a", "terminal-a");
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("terminal-a", null);
    setWorkspace("/tmp/terminal-b", "terminal-b");
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("terminal-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("terminal-split", refA, refB, "right")],
      activeItemId: "terminal-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        draftA,
      );
    });
    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });
    const createCall = landingMocks.request.mock.calls.find(
      (call) => call[0] === "epic.create",
    );
    expect(createCall?.[1]).toMatchObject({
      workspaces: [{ workspacePath: "/tmp/terminal-a" }],
    });
    expect(JSON.stringify(createCall?.[1])).not.toContain("/tmp/terminal-b");
    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: { kind: "epic" } },
      right: { kind: "tab", ref: refB },
    });
    queryClient.clear();
  });

  it("retains a staged intent when image preparation aborts before create", async () => {
    setSingleWorkspace();
    const stagingKey = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const stagedIntent = worktreeIntentFor(WORKSPACE_PATH, "retry-precreate");
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(stagingKey, stagedIntent);
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    const imageGate = deferred<Uint8Array | undefined>();
    imageStoreMocks.getImageBytes.mockReturnValue(imageGate.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("retry-image", "retry"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    const draftId = useLandingDraftStore.getState().activeDraftId;
    if (draftId === null) throw new Error("expected generated draft");
    draftRuntimeRegistry.close(draftId);
    imageGate.resolve(HELLO_BYTES);
    await act(async () => {
      await Promise.resolve();
    });
    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
    ).toEqual(stagedIntent);
    queryClient.clear();
  });

  it("retains a staged intent when the one-shot create rejects", async () => {
    setSingleWorkspace();
    const stagingKey = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const stagedIntent = worktreeIntentFor(WORKSPACE_PATH, "retry-reject");
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(stagingKey, stagedIntent);
    landingMocks.request.mockRejectedValue(new Error("create rejected"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useLandingComposerActions(), {
      wrapper: queryClientWrapper(queryClient),
    });

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt("retry create"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
    ).toEqual(stagedIntent);
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
  };
}

function editorHandleForPrompt(prompt: string): ComposerPromptEditorHandle {
  const content = jsonContentForPrompt(prompt);
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => prompt.length === 0,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
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
  setWorkspace(WORKSPACE_PATH, "traycer");
}

function setWorkspace(path: string, name: string): void {
  setGlobalWorkspaceFolders({
    folders: [path],
    folderInfoByPath: {
      [path]: {
        path,
        name,
        repoIdentifier: { owner: "traycerai", repo: name },
        hostId: TEST_HOST_ID,
      },
    },
  });
}

// Typed as the real store item so a change to the split shape (a renamed
// `routeBackingSide`, say) fails these fixtures instead of letting them keep
// compiling against a layout contract that no longer exists.
function splitItem(
  id: string,
  left: { readonly kind: "draft"; readonly id: string },
  right: { readonly kind: "draft"; readonly id: string },
  focusedSide: "left" | "right",
): SplitStripItem {
  return {
    kind: "split" as const,
    id,
    left: { kind: "tab" as const, ref: left },
    right: { kind: "tab" as const, ref: right },
    focusedSide,
    routeBackingSide: focusedSide,
    leftRatio: 0.5,
  };
}

function worktreeIntentFor(workspacePath: string, branchName: string) {
  return {
    entries: [
      {
        kind: "worktree" as const,
        scripts: null,
        workspacePath,
        repoIdentifier: { owner: "traycerai", repo: "traycer" },
        isPrimary: true,
        branch: {
          type: "new" as const,
          name: branchName,
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  };
}
