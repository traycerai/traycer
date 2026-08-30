import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
import { useHostClient } from "@/lib/host";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import {
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  focusActiveComposer,
  registerComposerFocus,
} from "@/lib/composer/composer-focus-registry";
import {
  registerTerminalFocus,
  resetTerminalFocusRegistryForTests,
} from "@/lib/terminals/terminal-focus-registry";
import { resetPrimaryFocusCoordinatorForTests } from "@/lib/focus/primary-focus-coordinator";
import { isMobileApp, setMobileApp } from "@/lib/mobile-app";
import { PrimaryFocusCoordinatorProvider } from "@/lib/focus/primary-focus-coordinator-provider";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { useTabsStore } from "@/stores/tabs/store";
import { LandingTerminalHost } from "@/components/home/terminal-panel/landing-terminal-host";
import {
  PaneActivationFocusIntentContext,
  type PaneActivationFocusIntent,
  usePaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

/**
 * Commit-level observation of the mocked LandingComposer's mount identity.
 * `useLayoutEffect` runs after each committed render (before paint / before
 * passive effects), so a passive-effect pending rotation leaves a detectable
 * intermediate commit that a render-phase rotation never produces.
 *
 * The null-draft pre-minted-key rotation this verifies is implemented one
 * level down, in `LandingDraftSurface` (`HomePage` only sets up
 * `DraftSurfaceProvider` and does not itself pre-mint anything). `HomePage`
 * renders the real, unmocked `LandingDraftSurface`, so rendering `<HomePage />`
 * here still exercises that guarantee end-to-end against this mocked
 * `LandingComposer`.
 */
type ComposerCommit = {
  readonly draftId: string | null;
  readonly pendingCreateId: string | null;
  /** `LandingDraftSurface` uses `draftId ?? pendingDraftId` as the React key. */
  readonly effectiveKey: string | null;
  readonly instanceId: number;
  readonly phase: "mount" | "commit" | "unmount";
};

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
    transportDialability: "dialable",
  })),
  composerCommits: [] as ComposerCommit[],
  nextInstanceId: 0,
  isMobile: false,
  tabActivity: { visible: true, focused: true },
  delayComposerRegistration: false,
}));

// Drive the viewport branch directly. jsdom reports a desktop width, so this
// only makes the default explicit - the phone case flips it per test.
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => homeMocks.isMobile,
  isMobileViewport: () => homeMocks.isMobile,
}));

vi.mock("@/components/layout/tab-surface-activity-hooks", () => ({
  useTabSurfaceActivity: () => homeMocks.tabActivity,
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

/** The composer's resolved placement (P1.2), pointed at the mocked host. */
function useTestPlacementTarget(): LandingPlacementTarget {
  return {
    resolvedHostId: homeMocks.getActiveHostId(),
    client: useHostClient(),
    hostLabel: "Local",
    isPinned: false,
    namedHostDead: false,
  };
}

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    request: homeMocks.request,
    getActiveHostId: homeMocks.getActiveHostId,
    getActiveHost: homeMocks.getActiveHost,
    getRequestContextUserId: homeMocks.getRequestContextUserId,
  }),
  // `landing-draft-store.ts` (real, unmocked) and `use-landing-composer-actions.ts`
  // (also real - invoked through the mocked `LandingComposer`'s `handleClick`)
  // both resolve the per-host workspace-folder bucket through an imperative
  // read, not through a hook. A whole-module mock missing one leaves the
  // import `undefined` and throws on the very first call.
  //
  // `activeHostIdOrNull` is that read now: the spine stopped carrying an
  // identity at P4.2/D17, so it resolves the authority projection instead.
  // Same knob as the spine below, so a test that moves the host moves both.
  activeHostIdOrNull: () => homeMocks.getActiveHostId(),
  getHostBindingSnapshot: () => ({
    hostClient: {
      request: homeMocks.request,
      getActiveHostId: homeMocks.getActiveHostId,
      getActiveHost: homeMocks.getActiveHost,
      getRequestContextUserId: homeMocks.getRequestContextUserId,
    },
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
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
    pendingCreateId: string | null;
    initialPrompt: string | undefined;
    initialSettings: unknown;
    workspaceControls: ReactNode;
    workspaceSlot: ReactNode;
  }) => {
    // The real composer reads surface activity from context (provided by
    // HomePage); the mock mirrors that so the gating stays observable.
    const activityEnabled = useSurfaceActivity();
    const paneActivationFocusIntent = usePaneActivationFocusIntent();
    const composerRef = useRef<HTMLButtonElement | null>(null);
    const delayComposerRegistration = homeMocks.delayComposerRegistration;
    const actions = useLandingComposerActions(useTestPlacementTarget());
    const draftId = props.draftId;
    const pendingCreateId = props.pendingCreateId;
    const effectiveKey = draftId ?? pendingCreateId;
    const instanceIdRef = useRef<number | null>(null);
    if (instanceIdRef.current === null) {
      homeMocks.nextInstanceId += 1;
      instanceIdRef.current = homeMocks.nextInstanceId;
    }
    const instanceId = instanceIdRef.current;

    useLayoutEffect(() => {
      if (delayComposerRegistration) return;
      const composer = composerRef.current;
      if (composer === null) return;
      return registerComposerFocus(
        `landing-test-${instanceId}`,
        {
          focus: () => composer.focus(),
          containsActiveElement: (activeElement) => activeElement === composer,
          isEligible: () => composer.isConnected,
        },
        activityEnabled,
      );
    }, [activityEnabled, delayComposerRegistration, instanceId]);
    useEffect(() => {
      if (delayComposerRegistration) return;
      const composer = composerRef.current;
      const focusScope =
        composer === null
          ? null
          : composer.closest("[data-primary-focus-scope='true']");
      if (
        activityEnabled &&
        // Mirrors the real editor's own gate: becoming active is not a user
        // gesture, so the installed mobile app never takes focus from it. The
        // mock carries it so a surface-driven focus is the only thing left that
        // could raise the keyboard here.
        !isMobileApp() &&
        !paneActivationFocusIntent.shouldYieldAutoFocus() &&
        (focusScope === null ||
          document.activeElement === null ||
          !focusScope.contains(document.activeElement))
      ) {
        focusActiveComposer();
      }
    }, [activityEnabled, delayComposerRegistration, paneActivationFocusIntent]);

    // Instance lifetime (keyed remounts). `instanceId` is allocated once per
    // React key identity; depend only on it so prop updates do not fake unmounts.
    useLayoutEffect(() => {
      homeMocks.composerCommits.push({
        draftId: null,
        pendingCreateId: null,
        effectiveKey: null,
        instanceId,
        phase: "mount",
      });
      return () => {
        homeMocks.composerCommits.push({
          draftId: null,
          pendingCreateId: null,
          effectiveKey: null,
          instanceId,
          phase: "unmount",
        });
      };
    }, [instanceId]);

    // Every committed prop snapshot (catches a stale key frame that reuses
    // the same React instance when the React key has not changed yet).
    useLayoutEffect(() => {
      homeMocks.composerCommits.push({
        draftId,
        pendingCreateId,
        effectiveKey,
        instanceId,
        phase: "commit",
      });
    });

    const handleClick = (): void => {
      actions.submit({
        draftId,
        editor: editorHandleForPrompt("Plan the GUI migration"),
        slashCatalog: null,
        toolbar: {
          selection: {
            harnessId: "codex",
            modelSlug: "gpt-5-codex",
            profileId: null,
          },
          reasoning: "high",
          serviceTier: "",
          permission: "supervised",
        },
      });
    };
    const handlePromptChangeTwice = (): void => {
      const exactDraftId =
        draftId ?? useLandingDraftStore.getState().createDraft(null);
      const runtime = draftRuntimeRegistry.getOrHydrate(exactDraftId);
      if (runtime === null) throw new Error("expected keyed draft runtime");
      runtime.setSnapshot(jsonContentForPrompt("first draft"), null);
      runtime.setSnapshot(jsonContentForPrompt("second draft"), null);
      draftRuntimeRegistry.flush(exactDraftId);
    };
    return (
      <div
        data-testid="landing-composer"
        data-activity-enabled={String(activityEnabled)}
        data-draft-id={draftId ?? ""}
        data-pending-create-id={pendingCreateId ?? ""}
        data-effective-key={effectiveKey ?? ""}
        data-instance-id={String(instanceId)}
      >
        <button
          ref={composerRef}
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
        {props.workspaceControls}
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

vi.mock("@/components/home/terminal-panel/landing-terminal-panel", () => ({
  LandingTerminalPanel: () => {
    const terminalRef = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      const terminal = terminalRef.current;
      if (terminal === null) return;
      return registerTerminalFocus(
        "landing-terminal-focus-test",
        () => terminal.focus(),
        (activeElement) => activeElement === terminal,
        () => terminal.isConnected,
      );
    }, []);
    return (
      <button
        ref={terminalRef}
        type="button"
        data-testid="landing-terminal-panel-slot"
      >
        Terminal input
      </button>
    );
  },
}));

vi.mock(
  "@/components/home/terminal-panel/landing-terminal-gesture-provider",
  () => ({
    LandingTerminalGestureProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);
import { HomePage } from "@/components/home/home-page";

// The workspace-folders store buckets by host; every fixture in this suite
// resolves the active host through `homeMocks.getActiveHostId()`, so seed and
// read that same host's bucket.
const TEST_HOST_ID = "host-home";
const INITIAL_TAB_LAYOUT = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};

function setGlobalWorkspaceFolders(
  folders: ReadonlyArray<string>,
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): void {
  useWorkspaceFoldersStore.setState({
    byHost: {
      [TEST_HOST_ID]: { folders, folderInfoByPath, primaryPath: null },
    },
  });
}

describe("<HomePage />", () => {
  beforeEach(() => {
    homeMocks.tabActivity = { visible: true, focused: true };
    homeMocks.delayComposerRegistration = false;
    __resetTabNavigationControllerForTesting();
    window.localStorage.clear();
    homeMocks.systemModalOpen = false;
    homeMocks.isMobile = false;
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
      transportDialability: "dialable",
    });
    homeMocks.composerCommits.length = 0;
    homeMocks.nextInstanceId = 0;
    useLandingTerminalStore.getState().resetForTests();
    useTabsStore.setState(INITIAL_TAB_LAYOUT);
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
    draftRuntimeRegistry.resetForTesting();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({ byHost: {} });
  });

  afterEach(() => {
    cleanup();
    resetTerminalFocusRegistryForTests();
    resetPrimaryFocusCoordinatorForTests();
    useLandingTerminalStore.getState().resetForTests();
    useTabsStore.setState(INITIAL_TAB_LAYOUT);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useMobileNavStore.setState({ open: false });
    setMobileApp(false);
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

  it("drops the embedded epics list at phone width, keeping the hero and composer", () => {
    homeMocks.isMobile = true;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    // The hamburger drawer already carries "Recent tasks" + "View all" off the
    // same useHistoryQuery, so the inline copy is pure duplication here.
    expect(screen.queryByTestId("epics-list-panel")).toBeNull();
    expect(screen.getByTestId("home-hero")).not.toBeNull();
    expect(screen.getByTestId("landing-composer")).not.toBeNull();
    queryClient.clear();
  });

  it("opens the nav drawer from the phone-only View history link", () => {
    homeMocks.isMobile = true;
    useMobileNavStore.setState({ open: false });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("home-view-history"));

    // Same drawer the header hamburger opens - that is where "Recent tasks"
    // lives once the embedded list is dropped at this width.
    expect(useMobileNavStore.getState().open).toBe(true);
    queryClient.clear();
  });

  it("keeps the View history link off the desktop landing page", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("home-view-history")).toBeNull();
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
    // The runtime owns this draft's writer; the mock flushes its exact id so the
    // assertion observes the latest independent mirror.

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
    setGlobalWorkspaceFolders(["/tmp/draft-app"], {
      "/tmp/draft-app": {
        path: "/tmp/draft-app",
        name: "draft-app",
        repoIdentifier: null,
        hostId: TEST_HOST_ID,
      },
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setActiveDraft(draftId);
    setGlobalWorkspaceFolders(["/tmp/global-app"], {
      "/tmp/global-app": {
        path: "/tmp/global-app",
        name: "global-app",
        repoIdentifier: null,
        hostId: TEST_HOST_ID,
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
    setGlobalWorkspaceFolders(["/tmp/traycer"], {
      "/tmp/traycer": {
        path: "/tmp/traycer",
        name: "traycer",
        repoIdentifier: null,
        hostId: TEST_HOST_ID,
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
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(homeMocks.navigate).not.toHaveBeenCalled();

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
    setGlobalWorkspaceFolders(["/tmp/gui-app", "/tmp/host"], {
      "/tmp/gui-app": {
        path: "/tmp/gui-app",
        name: "gui-app",
        repoIdentifier: { owner: "traycerai", repo: "gui-app" },
        hostId: TEST_HOST_ID,
      },
      "/tmp/host": {
        path: "/tmp/host",
        name: "host",
        repoIdentifier: { owner: "traycerai", repo: "host" },
        hostId: TEST_HOST_ID,
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

  describe("null-draft mount key rotation (production LandingDraftSurface, rendered live under HomePage)", () => {
    function renderHome(): QueryClient {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <HomePage />
        </QueryClientProvider>,
      );
      return queryClient;
    }

    function commitSnapshots(): ReadonlyArray<ComposerCommit> {
      return homeMocks.composerCommits.filter((c) => c.phase === "commit");
    }

    function mounts(): ReadonlyArray<ComposerCommit> {
      return homeMocks.composerCommits.filter((c) => c.phase === "mount");
    }

    const noPaneFocusIntent: PaneActivationFocusIntent = {
      mark: () => undefined,
      shouldYieldAutoFocus: () => false,
    };

    function seedFocusedLandingTerminal(maximized: boolean): void {
      useLandingDraftStore.getState().createDraftWithId("draft-a", null);
      useLandingDraftStore.getState().setActiveDraft("draft-a");
      useTabsStore.setState({
        items: [
          {
            kind: "tab",
            id: "item-draft-a",
            ref: { kind: "draft", id: "draft-a" },
          },
        ],
        activeItemId: "item-draft-a",
      });
      const terminalStore = useLandingTerminalStore.getState();
      terminalStore.addTab({
        instanceId: "landing-terminal-focus-test",
        sessionId: "terminal-session-test",
        hostId: TEST_HOST_ID,
        cwd: "/tmp",
        name: "Terminal",
        titleSource: "default",
      });
      terminalStore.setPanelOpen("draft-a", true);
      terminalStore.setPanelMaximized("draft-a", maximized);
    }

    function renderLandingFocusHarness(focusIntent: PaneActivationFocusIntent) {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const tree = () => (
        <PrimaryFocusCoordinatorProvider>
          <QueryClientProvider client={queryClient}>
            <button type="button" data-testid="other-tab-control">
              Other tab
            </button>
            <PaneActivationFocusIntentContext.Provider value={focusIntent}>
              <HomePage />
            </PaneActivationFocusIntentContext.Provider>
            <LandingTerminalHost />
          </QueryClientProvider>
        </PrimaryFocusCoordinatorProvider>
      );
      const view = render(tree());
      return { queryClient, tree, view };
    }

    it("restores terminal focus through the real landing portal after tab reactivation", async () => {
      seedFocusedLandingTerminal(false);
      const { queryClient, tree, view } =
        renderLandingFocusHarness(noPaneFocusIntent);
      const terminal = await screen.findByTestId("landing-terminal-panel-slot");
      expect(
        screen.getByTestId("landing-draft-surface").contains(terminal),
      ).toBe(true);
      terminal.focus();
      expect(document.activeElement).toBe(terminal);

      homeMocks.tabActivity = { visible: false, focused: false };
      view.rerender(tree());
      screen.getByTestId("other-tab-control").focus();

      homeMocks.tabActivity = { visible: true, focused: true };
      view.rerender(tree());

      expect(document.activeElement).toBe(terminal);
      queryClient.clear();
    });

    it("focuses the active terminal when a maximized landing surface mounts already focused", async () => {
      seedFocusedLandingTerminal(true);
      const { queryClient } = renderLandingFocusHarness(noPaneFocusIntent);

      expect(document.activeElement).toBe(
        await screen.findByTestId("landing-terminal-panel-slot"),
      );
      queryClient.clear();
    });

    it("does not focus a retained inactive composer while the focused editor registers asynchronously", async () => {
      useLandingDraftStore.getState().createDraftWithId("draft-a", null);
      useLandingDraftStore.getState().setActiveDraft("draft-a");
      homeMocks.delayComposerRegistration = true;
      const inactiveComposer = document.createElement("button");
      inactiveComposer.type = "button";
      document.body.append(inactiveComposer);
      const unregisterInactive = registerComposerFocus(
        "retained-inactive-split-partner",
        {
          focus: () => inactiveComposer.focus(),
          containsActiveElement: (activeElement) =>
            activeElement === inactiveComposer,
          isEligible: () => inactiveComposer.isConnected,
        },
        false,
      );

      const { queryClient, tree, view } =
        renderLandingFocusHarness(noPaneFocusIntent);

      expect(document.activeElement).not.toBe(inactiveComposer);

      homeMocks.delayComposerRegistration = false;
      view.rerender(tree());
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByTestId("landing-submit"),
        );
      });

      unregisterInactive();
      inactiveComposer.remove();
      queryClient.clear();
    });

    // The installed mobile app's rule: only a gesture may raise the software
    // keyboard. The landing surface reaches both endpoints through their focus
    // registries, so neither endpoint's own guard is on this path - the guard
    // has to be here, and these two cases are what hold it.
    it("takes no focus on the mobile app when the landing surface becomes focused", async () => {
      setMobileApp(true);
      useLandingDraftStore.getState().createDraftWithId("draft-a", null);
      useLandingDraftStore.getState().setActiveDraft("draft-a");
      const { queryClient } = renderLandingFocusHarness(noPaneFocusIntent);

      // The composer IS registered and active - without that this would pass on
      // a surface that simply had no endpoint to focus.
      const submit = await screen.findByTestId("landing-submit");
      expect(document.activeElement).not.toBe(submit);
      expect(document.body.contains(submit)).toBe(true);
      queryClient.clear();
    });

    it("leaves a maximized landing terminal unfocused on the mobile app", async () => {
      setMobileApp(true);
      seedFocusedLandingTerminal(true);
      const { queryClient } = renderLandingFocusHarness(noPaneFocusIntent);

      const terminal = await screen.findByTestId("landing-terminal-panel-slot");
      expect(document.activeElement).not.toBe(terminal);
      queryClient.clear();
    });

    it("restores the maximized terminal after a system modal closes", async () => {
      seedFocusedLandingTerminal(true);
      const { queryClient, tree, view } =
        renderLandingFocusHarness(noPaneFocusIntent);
      const terminal = await screen.findByTestId("landing-terminal-panel-slot");
      expect(document.activeElement).toBe(terminal);

      homeMocks.systemModalOpen = true;
      view.rerender(tree());
      screen.getByTestId("other-tab-control").focus();

      homeMocks.systemModalOpen = false;
      view.rerender(tree());

      expect(document.activeElement).toBe(terminal);
      queryClient.clear();
    });

    it("yields restoration to the control that activates an unfocused draft pane", () => {
      seedFocusedLandingTerminal(false);
      const focusIntent: PaneActivationFocusIntent = {
        mark: () => undefined,
        shouldYieldAutoFocus: () => true,
      };
      homeMocks.tabActivity = { visible: true, focused: false };
      const { queryClient, tree, view } =
        renderLandingFocusHarness(focusIntent);
      const activatingControl = screen.getByTestId("landing-change-twice");
      activatingControl.focus();

      homeMocks.tabActivity = { visible: true, focused: true };
      view.rerender(tree());

      expect(document.activeElement).toBe(activatingControl);
      queryClient.clear();
    });

    it("never commits a null-draft frame still keyed by a pending-created draft id", () => {
      const queryClient = renderHome();

      // Initial null session: pendingCreateId is the mount key.
      const initial = commitSnapshots().at(-1);
      expect(initial?.draftId).toBeNull();
      expect(initial?.pendingCreateId).toBeTruthy();
      const pendingKey = initial?.pendingCreateId ?? "";
      expect(initial?.effectiveKey).toBe(pendingKey);

      // Create the draft WITH that pre-minted id (mirrors LandingComposer's
      // real handleSnapshot create branch, which calls
      // createDraftWithId(props.pendingCreateId ?? uuidv4(), settings)).
      act(() => {
        useLandingDraftStore.getState().createDraftWithId(pendingKey, null);
      });
      expect(useLandingDraftStore.getState().activeDraftId).toBe(pendingKey);
      const bound = commitSnapshots().at(-1);
      expect(bound?.draftId).toBe(pendingKey);
      expect(bound?.pendingCreateId).toBeNull();
      expect(bound?.effectiveKey).toBe(pendingKey);

      const commitsBeforeClear = homeMocks.composerCommits.length;
      const mountsBeforeClear = mounts().length;

      act(() => {
        useLandingDraftStore.getState().clearActiveDraft();
      });

      // Passive-effect rotation would leave a committed frame with
      // draftId=null and effectiveKey=pendingKey (retired id) before reminting.
      // Render-phase rotation must never produce that frame.
      const afterClear = homeMocks.composerCommits.slice(commitsBeforeClear);
      const nullCommits = afterClear.filter(
        (c) => c.phase === "commit" && c.draftId === null,
      );
      expect(nullCommits.length).toBeGreaterThan(0);
      expect(nullCommits.every((c) => c.effectiveKey !== pendingKey)).toBe(
        true,
      );
      // Exactly one distinct new null-session key (no double remount).
      const nullKeys = [
        ...new Set(nullCommits.map((c) => c.effectiveKey).filter(Boolean)),
      ];
      expect(nullKeys).toHaveLength(1);
      expect(nullKeys[0]).not.toBe(pendingKey);

      // One remount for the rotation (not zero, not two).
      const mountsAfter = mounts().length - mountsBeforeClear;
      expect(mountsAfter).toBe(1);

      // Flush passive effects: still no late second remint.
      act(() => {
        /* flush */
      });
      const lateNullKeys = [
        ...new Set(
          homeMocks.composerCommits
            .slice(commitsBeforeClear)
            .filter((c) => c.phase === "commit" && c.draftId === null)
            .map((c) => c.effectiveKey)
            .filter(Boolean),
        ),
      ];
      expect(lateNullKeys).toEqual(nullKeys);

      queryClient.clear();
    });

    it("remounts exactly once when a pre-existing bound draft goes null", () => {
      // Bind a draft whose id is NOT the LandingDraftSurface pending mint.
      const existingId = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore.getState().setActiveDraft(existingId);

      const queryClient = renderHome();

      const bound = commitSnapshots().at(-1);
      expect(bound?.draftId).toBe(existingId);
      expect(bound?.effectiveKey).toBe(existingId);
      const mountsBeforeClear = mounts().length;
      // Capture any pending id that was never used as a key while bound.
      const commitsBeforeClear = homeMocks.composerCommits.length;

      act(() => {
        useLandingDraftStore.getState().clearActiveDraft();
      });

      const afterClear = homeMocks.composerCommits.slice(commitsBeforeClear);
      // Every mount after the clear — intermediate stale-pending would be
      // an extra mount entry.
      const mountsAfterClear = afterClear.filter((c) => c.phase === "mount");
      expect(mountsAfterClear).toHaveLength(1);

      const nullCommits = afterClear.filter(
        (c) => c.phase === "commit" && c.draftId === null,
      );
      expect(nullCommits.length).toBeGreaterThan(0);
      // No committed null frame still keyed by the retired bound draft.
      expect(nullCommits.every((c) => c.effectiveKey !== existingId)).toBe(
        true,
      );
      // Exactly one distinct null-session key across ALL commits (not
      // existing → stale-pending → new-pending collapsing to endpoints).
      const nullKeys = [
        ...new Set(nullCommits.map((c) => c.effectiveKey).filter(Boolean)),
      ];
      expect(nullKeys).toHaveLength(1);

      // Flush passives: a useEffect remint would add a second mount/key.
      act(() => {
        /* flush */
      });
      const mountsTotalAfter = mounts().length - mountsBeforeClear;
      expect(mountsTotalAfter).toBe(1);
      const lateNullKeys = [
        ...new Set(
          homeMocks.composerCommits
            .slice(commitsBeforeClear)
            .filter((c) => c.phase === "commit" && c.draftId === null)
            .map((c) => c.effectiveKey)
            .filter(Boolean),
        ),
      ];
      expect(lateNullKeys).toHaveLength(1);

      queryClient.clear();
    });
  });
});

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
