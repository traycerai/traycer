import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  useLandingComposerStore,
  flushPendingLandingDraftContent,
} from "@/stores/composer/landing-composer-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

const homeMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  systemModalOpen: false,
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  getActiveHostId: vi.fn(() => "host-home"),
  getRequestContextUserId: vi.fn<() => string | null>(() => "user-home"),
  getActiveHost: vi.fn(() => ({
    hostId: "host-home",
    label: "Local",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    status: "available",
  })),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => homeMocks.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: {
      location: { search: Record<string, unknown> };
    }) => unknown;
  }) =>
    select({
      location: {
        search: homeMocks.systemModalOpen ? { historyOverlay: true } : {},
      },
    }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => ({
    request: homeMocks.request,
    getActiveHostId: homeMocks.getActiveHostId,
    getActiveHost: homeMocks.getActiveHost,
    getRequestContextUserId: homeMocks.getRequestContextUserId,
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    request: homeMocks.request,
    getActiveHostId: homeMocks.getActiveHostId,
    getActiveHost: homeMocks.getActiveHost,
    getRequestContextUserId: homeMocks.getRequestContextUserId,
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({
    create: () => Promise.resolve(),
    isPending: false,
  }),
}));

vi.mock("@/components/home/home-hero", () => ({
  HomeHero: (props: {
    readonly workspaceFolders: ReadonlyArray<string> | null;
  }) => (
    <div
      data-testid="home-hero"
      data-workspace-folders={props.workspaceFolders?.join("|") ?? "global"}
    />
  ),
}));

vi.mock("@/components/home/composer/landing-composer", () => ({
  LandingComposer: (props: {
    draftId: string | null;
    initialPrompt: string | undefined;
    initialSettings: unknown;
    workspaceSlot: ReactNode;
  }) => {
    // The real composer reads surface activity from context (provided by
    // HomePage); the mock mirrors that so the gating stays observable.
    const activityEnabled = useSurfaceActivity();
    const actions = useLandingComposerActions();
    const setSnapshot = useLandingComposerStore((s) => s.setSnapshot);
    const draftId = props.draftId;
    const handleClick = (): void => {
      actions.submit({
        editor: editorHandleForPrompt("Plan the GUI migration"),
        toolbar: {
          selection: { harnessId: "codex", modelSlug: "gpt-5-codex" },
          reasoning: "high",
          serviceTier: "",
          permission: "supervised",
          agentMode: "regular",
        },
      });
    };
    const handlePromptChangeTwice = (): void => {
      setSnapshot(draftId, jsonContentForPrompt("first draft"), null);
      setSnapshot(draftId, jsonContentForPrompt("second draft"), null);
    };
    return (
      <div
        data-testid="landing-composer"
        data-activity-enabled={String(activityEnabled)}
      >
        <button
          type="button"
          data-testid="landing-submit"
          onClick={handleClick}
        >
          Submit
        </button>
        <button
          type="button"
          data-testid="landing-change-twice"
          onClick={handlePromptChangeTwice}
        >
          Change Twice
        </button>
        <div data-testid="landing-initial-prompt">
          {props.initialPrompt ?? ""}
        </div>
        {props.workspaceSlot}
      </div>
    );
  },
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => <div data-testid="host-workspace-selector" />,
  }),
);

vi.mock("@/components/home/host-update-banner", () => ({
  HostUpdateBanner: () => <div data-testid="host-update-banner-slot" />,
}));

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: () => <div data-testid="epics-list-panel" />,
}));
import { HomePage } from "@/components/home/home-page";

describe("<HomePage />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    homeMocks.systemModalOpen = false;
    homeMocks.navigate.mockReset();
    homeMocks.request.mockReset();
    homeMocks.getActiveHostId.mockReset();
    homeMocks.getActiveHostId.mockReturnValue("host-home");
    homeMocks.getActiveHost.mockReset();
    homeMocks.getActiveHost.mockReturnValue({
      hostId: "host-home",
      label: "Local",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      status: "available",
    });
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "test-user",
        userName: "alice",
        email: "alice@example.com",
      },
      contextMetadata: { userId: "test-user", username: "alice" },
    });
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    // Reset the composer's binding/session state so a draft created in one
    // test can't route a later test's null-binding snapshots.
    useLandingComposerStore.getState().reset();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
    });
  });

  afterEach(() => {
    cleanup();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
    });
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("mounts the host-update banner above the hero", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("host-update-banner-slot")).toBeTruthy();
    queryClient.clear();
  });

  it("renders the embedded epics list normally, but unmounts it while a system modal occludes the home page", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("epics-list-panel")).not.toBeNull();
    expect(screen.getByTestId("landing-composer").dataset.activityEnabled).toBe(
      "true",
    );

    homeMocks.systemModalOpen = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("epics-list-panel")).toBeNull();
    expect(screen.getByTestId("landing-composer").dataset.activityEnabled).toBe(
      "false",
    );
    queryClient.clear();
  });

  it("keeps same-tick composer snapshots on one draft tab", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("landing-change-twice"));
    // The draft is created synchronously on the first snapshot, but subsequent
    // content writes are debounced (landing-composer-store); flush so the assert
    // sees the coalesced latest content rather than a mid-debounce value.
    flushPendingLandingDraftContent();

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(extractPlainTextFromComposerJSONContent(draft.content)).toBe(
      "second draft",
    );
    expect(useLandingDraftStore.getState().activeDraftId).toBe(draft.id);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    queryClient.clear();
  });

  it("passes the active draft workspace folders to the hero", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/draft-app"],
      folderInfoByPath: {
        "/tmp/draft-app": {
          path: "/tmp/draft-app",
          name: "draft-app",
          repoIdentifier: null,
        },
      },
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setActiveDraft(draftId);
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/global-app"],
      folderInfoByPath: {
        "/tmp/global-app": {
          path: "/tmp/global-app",
          name: "global-app",
          repoIdentifier: null,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("home-hero").dataset.workspaceFolders).toBe(
      "/tmp/draft-app",
    );
    queryClient.clear();
  });

  it("creates a host-backed epic and navigates to the returned route", async () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/traycer"],
      folderInfoByPath: {
        "/tmp/traycer": {
          path: "/tmp/traycer",
          name: "traycer",
          repoIdentifier: null,
        },
      },
    });
    homeMocks.request.mockResolvedValue({ roomInfo: null });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
        },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("landing-submit"));

    await waitFor(() => {
      expect(
        homeMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // Locate the epic.create call explicitly rather than by index.
    const call: ReadonlyArray<unknown> =
      homeMocks.request.mock.calls.find((c) => c[0] === "epic.create") ?? [];
    const method: unknown = call[0];
    const request: unknown = call[1];
    if (typeof request !== "object" || request === null) {
      throw new Error("expected create-epic request");
    }
    if (!("epic" in request)) {
      throw new Error("expected epic payload");
    }
    const epic: unknown = request.epic;
    if (typeof epic !== "object" || epic === null) {
      throw new Error("expected epic body");
    }
    const epicId: unknown = (epic as { id: unknown }).id;
    if (typeof epicId !== "string") {
      throw new Error("expected epic id");
    }

    expect(method).toBe("epic.create");
    // Chat epics store an empty `title` at create; the prompt rides on
    // `initialUserPrompt` and is derived for display via `epicDisplayTitle`.
    expect(request).toMatchObject({
      epic: {
        id: epicId,
        title: "",
        initialUserPrompt: "Plan the GUI migration",
        createdBy: "alice@example.com",
        version: "2.0.0",
      },
      repoIdentifiers: [],
      workspaces: [{ workspacePath: "/tmp/traycer" }],
    });

    await waitFor(() => {
      expect(homeMocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/epics/$epicId/$tabId",
        }),
      );
    });

    // `useEpicCreate` refetches the new epic's workspace listings so the chat
    // tile's folder chip reflects the attached folders once the epic exists,
    // but must not blanket-invalidate the host scope or the manual-refresh-
    // only history list. Every host-scoped invalidation it fires targets a
    // worktree binding listing method.
    const hostInvalidations = invalidateSpy.mock.calls
      .map(([options]) => (options as { queryKey?: unknown }).queryKey)
      .filter(
        (queryKey): queryKey is unknown[] =>
          Array.isArray(queryKey) && queryKey[0] === "host",
      );
    expect(hostInvalidations.length).toBeGreaterThan(0);
    expect(
      hostInvalidations.every(
        (queryKey) => queryKey[2] === "worktree.listBindingsForEpic",
      ),
    ).toBe(true);
    queryClient.clear();
  });

  it("includes selected workspace folders and detected repos when creating an epic", async () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/gui-app", "/tmp/host"],
      folderInfoByPath: {
        "/tmp/gui-app": {
          path: "/tmp/gui-app",
          name: "gui-app",
          repoIdentifier: { owner: "traycerai", repo: "gui-app" },
        },
        "/tmp/host": {
          path: "/tmp/host",
          name: "host",
          repoIdentifier: { owner: "traycerai", repo: "host" },
        },
      },
    });
    homeMocks.request.mockResolvedValue({ roomInfo: null });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("landing-submit"));

    await waitFor(() => {
      expect(
        homeMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // Submit also fires a best-effort provider pre-warm (agent.gui.listModels);
    // locate the epic.create call explicitly rather than by index.
    const createEpicCall = homeMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [
        { owner: "traycerai", repo: "gui-app" },
        { owner: "traycerai", repo: "host" },
      ],
      workspaces: [
        { workspacePath: "/tmp/gui-app" },
        { workspacePath: "/tmp/host" },
      ],
    });
    queryClient.clear();
  });
});

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
