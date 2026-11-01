import {
  act,
  cleanup,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { LandingStagedSandboxTaskArgs } from "@/components/home/hooks/use-landing-composer-actions";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

// What the host can run: the person's Codex pick is not among it, so Claude
// is shown.
const host = vi.hoisted(() => ({
  harnesses: {
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: false },
      { id: "traycer", available: false },
    ],
  },
  /** Whether Claude's models have been answered by the host. */
  claudeModelsLoaded: true,
  toolbar: null as ComposerToolbarStore | null,
  editContent: null as ComposerBodyProps["onDocumentChange"] | null,
  installEditor: null as (() => void) | null,
  snapshot: null as (() => void) | null,
  /** The sandbox's own Traycer list: `undefined` while it loads. */
  cloudModels: undefined as ReadonlyArray<string> | undefined,
  cloudFetching: false,
  /** Whether the composer body draws the real model picker, whose chip a test reads. */
  renderPicker: false,
  /** Whether the directory has a row for the composer's host. */
  directoryNamesHost: true,
  /** The host's Traycer list, by slug and chip label. */
  traycerHostModels: [{ slug: "traycer-default", label: "traycer-default" }],
  startTask: vi.fn(),
  submit: vi.fn(),
  clearEditor: vi.fn(),
}));

const PLACEMENT_CLIENT = vi.hoisted(() => ({ hostId: "host-test" }));
const HOST_ID = "host-test";
const SURFACE = "landing:window-test";

function modelOption(harnessId: GuiHarnessId, slug: string): ModelOption {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

// Stable references: a fresh list per render would push a new catalog on
// every render.
const CLAUDE_MODELS = { models: [modelOption("claude", "sonnet-5.5")] };
const CODEX_MODELS = { models: [modelOption("codex", "gpt-6-astra")] };
// Stable per answer: a fresh array per render would push a new catalog on
// every render.
let cloudCache: {
  readonly from: ReadonlyArray<string>;
  readonly options: ReadonlyArray<ModelOption>;
} | null = null;
function cloudModelOptions() {
  const slugs = host.cloudModels;
  if (slugs === undefined) return undefined;
  if (cloudCache?.from !== slugs)
    cloudCache = {
      from: slugs,
      options: slugs.map((slug) => modelOption("traycer", slug)),
    };
  return cloudCache.options;
}

let hostListCache: {
  readonly from: typeof host.traycerHostModels;
  readonly list: {
    readonly models: ReadonlyArray<ModelOption>;
  };
} | null = null;
const traycerHostList = () => {
  if (hostListCache?.from !== host.traycerHostModels)
    hostListCache = {
      from: host.traycerHostModels,
      list: {
        models: host.traycerHostModels.map((m) => ({
          ...modelOption("traycer", m.slug),
          label: m.label,
        })),
      },
    };
  return hostListCache.list;
};

vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/harnesses/use-gui-harness-catalog")
    >()),
    useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
    useGuiHarnessModelsQueryForClient: (
      _client: unknown,
      harnessId: string,
    ) => {
      if (harnessId === "claude")
        return { data: host.claudeModelsLoaded ? CLAUDE_MODELS : undefined };
      return {
        data: harnessId === "traycer" ? traycerHostList() : CODEX_MODELS,
      };
    },
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  // The query's own shape: a read that has not answered is pending.
  useSandboxTraycerModels: () => {
    const data = cloudModelOptions();
    return {
      data,
      isPending: data === undefined,
      isFetching: host.cloudFetching,
      fetchStatus: host.cloudFetching
        ? ("fetching" as const)
        : ("idle" as const),
      isError: false,
    };
  },
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

// The editor and toolbar chrome are held by their own suites; the body hands
// back the real toolbar store the composer built and the edit handler.
vi.mock("@/components/home/composer/composer-body", async () => {
  const { HarnessModelPicker } =
    await import("@/components/home/pickers/harness-model-picker");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      host.toolbar = props.toolbarStore;
      host.editContent = props.onDocumentChange;
      host.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      host.snapshot = () => {
        props.onDocumentChange(TYPED, { from: 1, to: 1 });
      };
      return (
        <>
          <button
            type="button"
            disabled={props.isSubmitting || !props.canSubmit}
            onClick={props.onSubmit}
          >
            Submit landing
          </button>
          <TooltipProvider delayDuration={0}>
            <HarnessModelPicker
              withUltracode={false}
              labelDisplay="responsive"
              store={props.toolbarStore}
              maxModeContext={{ kind: "none" }}
              withServiceTier={false}
              withReasoning
              tuiOnly={false}
              lockedHarnessId={null}
              disabled={false}
              registerActivation={false}
              createProfileHostId={null}
              runTargetHostId={null}
              profileAdmission={null}
              terminalLoginSurface={null}
              embedding={null}
            />
          </TooltipProvider>
          {props.workspaceControls}
          {props.topBanner}
        </>
      );
    },
  };
});

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: HOST_ID,
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: {
      resolvedHostId: HOST_ID,
      client: PLACEMENT_CLIENT,
      hostLabel: "Local",
      isPinned: false,
      namedHostDead: false,
    },
    hostLabelFor: () => "Local",
  }),
}));
vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => SURFACE,
  }),
);
vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: host.submit,
    selectTerminalAgent: vi.fn(),
    startTaskOnStagedSandbox: host.startTask,
    placementAdmitsTask: () => true,
    isPending: false,
    attachmentUpload: null,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const named = hostOptionsFixture({
    hosts: [
      hostScopeOptionFixture({
        hostId: "host-test",
        name: "Hardiks-MacBook-Pro---Traycer.local",
        isLocalMachine: true,
      }),
    ],
  });
  const unlisted = hostOptionsFixture({ hosts: [] });
  return { useHostOptions: () => (host.directoryNamesHost ? named : unlisted) };
});
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    signInUrl: "https://billing.test",
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
    },
  }),
}));
vi.mock("@/hooks/composer/use-landing-composer-paste", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/composer/use-landing-composer-paste")
    >();
  return {
    ...actual,
    useLandingComposerPaste: () => ({
      onPaste: vi.fn(),
      onDrop: vi.fn(),
      onDragOver: vi.fn(),
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      attachImageFiles: vi.fn(),
      runPendingImageJob: vi.fn(),
      isDraggingFiles: false,
      dragOverlayVariant: null,
      isIngestingImages: false,
      isResolvingFilePaths: false,
    }),
  };
});
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
}));
vi.mock("@/components/home/composer/surface-activity-hooks", () => ({
  useSurfaceActivity: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGate: () => ({ blocked: false, hint: null, preparing: null }),
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));
vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: false,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
  }),
}));
vi.mock("@/components/chat/composer/provider-reauth-banner", () => ({
  ProviderReauthBanner: () => null,
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-landing-image-fetcher", () => ({
  useLandingImageFetcher: () => vi.fn(),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [] },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
  useHostDirectory: () => ({
    findById: () => null,
    onChange: () => ({ dispose: () => undefined }),
  }),
  useHostRuntimeClient: () => null,
}));
vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));
vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/providers/use-providers-list-query")
    >()),
    useProvidersListForClient: () => ({ data: undefined, isError: false }),
  }),
);

import { LandingComposer } from "../landing-composer";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import { CHECKING_SANDBOX_AGENTS } from "@/lib/sandboxes/sandbox-strings";
import { chipModelName } from "@/stores/composer/composer-toolbar-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

// The person's own pick, as their last run left it.
const PICK: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-6-astra",
  permissionMode: "supervised",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const NEW_STAGE: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 8192,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "",
  wakeString: null,
};

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const TRAYCER_PICK: ChatRunSettings = {
  ...PICK,
  harnessId: "traycer",
  model: "traycer-saved",
  reasoningEffort: null,
};

/** The draft's give-back record, as a reload finds it. */
function signInAndReturnSandbox(draftId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, {
    target: NEW_STAGE,
    clientRequestId: null,
  });
}

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function composer(
  draftId: string | null,
  initialSettings: ChatRunSettings | null,
) {
  return (
    <LandingComposer
      draftId={draftId}
      pendingCreateId={draftId === null ? "pending-draft" : null}
      initialSettings={initialSettings}
      workspaceControls={() => null}
    />
  );
}

function mount(
  draftId: string | null,
  initialSettings: ChatRunSettings | null,
) {
  return render(composer(draftId, initialSettings));
}

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => TYPED,
    isEmpty: () => false,
    clear: host.clearEditor,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    draftGeneration: () => 0,
    dismissActiveSuggestion: () => false,
  };
}

function draftSettings(draftId: string): ChatRunSettings | null {
  return (
    useLandingDraftStore.getState().drafts.find((d) => d.id === draftId)
      ?.settings ?? null
  );
}

function toolbar(): ComposerToolbarStore {
  if (host.toolbar === null) throw new Error("the composer did not mount");
  return host.toolbar;
}

function lastRunSettings() {
  return useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_ID);
}

beforeEach(() => {
  localStorage.clear();
  host.toolbar = null;
  host.editContent = null;
  host.claudeModelsLoaded = true;
  host.cloudModels = undefined;
  host.cloudFetching = false;
  host.directoryNamesHost = true;
  host.renderPicker = false;
  host.traycerHostModels = [
    { slug: "traycer-default", label: "traycer-default" },
  ];
  host.startTask.mockReset();
  host.startTask.mockImplementation(
    (args: LandingStagedSandboxTaskArgs): null => {
      args.hand("epic-new");
      return null;
    },
  );
  host.submit.mockReset();
  host.clearEditor.mockReset();
  usePendingSandboxSendStore.setState({ sends: {} });
  host.harnesses = {
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: false },
      { id: "traycer", available: false },
    ],
  };
  useStagedSandboxStore.setState({ bySurface: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().setGlobalRunSettings(HOST_ID, PICK, 1);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a landing composer with a sandbox staged", () => {
  it("writes the kept pick to its draft and not to the host's last-run settings, and shows it after a reload", async () => {
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    const lastRun = lastRunSettings();
    const first = mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });

    await waitFor(() =>
      expect(draftSettings(draftId)?.harnessId).toBe("claude"),
    );
    expect(lastRunSettings()).toBe(lastRun);
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});

    // The reload: a composer's stage is in memory only, so the store starts
    // empty and the draft's give-back record restores it.
    first.unmount();
    useStagedSandboxStore.setState({ bySurface: {} });
    signInAndReturnSandbox(draftId);
    mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(toolbar().getState().selection.harnessId).toBe("claude");
    expect(pickedRunSettings(toolbar().getState()).harnessId).toBe("claude");
  });

  it("mints a draft that holds the kept pick, not the host's last-run pick", async () => {
    const lastRun = lastRunSettings();
    mount(null, null);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().values.selection.harnessId).toBe("claude"),
    );

    // The first real edit mints the draft.
    act(() => {
      host.editContent?.(TYPED, { from: 1, to: 1 });
    });

    const minted = useLandingDraftStore.getState().drafts;
    expect(minted).toHaveLength(1);
    expect(minted[0]?.settings?.harnessId).toBe("claude");
    expect(minted[0]?.settings?.model).toBe("sonnet-5.5");
    expect(lastRunSettings()).toBe(lastRun);
  });

  it("mints a draft from the host's last run when no sandbox is staged", async () => {
    mount(null, null);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );

    act(() => {
      host.editContent?.(TYPED, { from: 1, to: 1 });
    });

    const minted = useLandingDraftStore.getState().drafts;
    expect(minted).toHaveLength(1);
    expect(minted[0]?.settings?.harnessId).toBe("codex");
  });

  it("leaves a restored stage's draft on its own pick", async () => {
    // The name a list gave this pick before the stage dropped it.
    useComposerHarnessMemoryStore
      .getState()
      .recordModelName("traycer", "traycer-saved", "Saved Traycer");
    host.renderPicker = true;
    const draftId = useLandingDraftStore.getState().createDraft(TRAYCER_PICK);
    signInAndReturnSandbox(draftId);
    const before = draftSettings(draftId);

    // A reload: no stage in memory, Traycer unavailable here, so the first
    // catalog shows a local reroute; then the draft's give-back is restored.
    mount(draftId, before);
    await waitFor(() =>
      expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toBeDefined(),
    );
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );

    expect(draftSettings(draftId)).toBe(before);
    expect(draftSettings(draftId)?.harnessId).toBe("traycer");
    expect(pickedRunSettings(toolbar().getState()).harnessId).toBe("traycer");
    // The chip says the model Send carries.
    expect(pickedRunSettings(toolbar().getState()).model).toBe("traycer-saved");
    expect(
      await screen.findByRole("button", { name: /^Saved Traycer/ }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Select model/ })).toBeNull();
  });

  it("takes a deferred edit to the draft with the kept pick, and emits nothing", async () => {
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    const lastRun = lastRunSettings();
    mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    // On a rerouted pick the edit defers until the catalog confirms it.
    act(() => {
      toolbar().getState().setPermission("full_access");
    });
    expect(toolbar().getState().pendingSettingsEmit).toBe(true);

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });

    await waitFor(() =>
      expect(draftSettings(draftId)?.harnessId).toBe("claude"),
    );
    expect(draftSettings(draftId)?.permissionMode).toBe("full_access");
    expect(toolbar().getState().pendingSettingsEmit).toBe(false);
    expect(lastRunSettings()).toBe(lastRun);
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});

    // A later catalog push that changes nothing about the pick emits nothing.
    act(() => {
      const state = toolbar().getState();
      state.setCatalog({
        ...state.catalog,
        ultracodeCarried: !state.catalog.ultracodeCarried,
      });
    });
    expect(lastRunSettings()).toBe(lastRun);
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
  });

  it("writes the kept pick to the draft once its model has resolved, never an empty one", async () => {
    host.claudeModelsLoaded = false;
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    const written: Array<string | undefined> = [draftSettings(draftId)?.model];
    const stop = useLandingDraftStore.subscribe((state) => {
      const model = state.drafts.find((d) => d.id === draftId)?.settings?.model;
      if (written[written.length - 1] !== model) written.push(model);
    });
    const view = mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    expect(toolbar().getState().selection.modelSlug).toBe("");

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(draftSettings(draftId)?.harnessId).toBe("codex");

    // The host answers Claude's models.
    host.claudeModelsLoaded = true;
    view.rerender(
      <LandingComposer
        draftId={draftId}
        pendingCreateId={null}
        initialSettings={draftSettings(draftId)}
        workspaceControls={() => null}
      />,
    );
    await waitFor(() =>
      expect(draftSettings(draftId)?.model).toBe("sonnet-5.5"),
    );
    stop();

    expect(draftSettings(draftId)?.harnessId).toBe("claude");
    expect(written).toEqual(["gpt-6-astra", "sonnet-5.5"]);
  });

  it("mints under a stage whose model is unresolved without throwing, and the pick follows once it resolves", async () => {
    host.claudeModelsLoaded = false;
    const lastRun = lastRunSettings();
    const view = mount(null, null);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().values.selection.harnessId).toBe("claude"),
    );

    // The first edit mints a draft while the shown pick has no model yet.
    act(() => {
      host.editContent?.(TYPED, { from: 1, to: 1 });
    });
    const minted = useLandingDraftStore.getState().drafts;
    expect(minted).toHaveLength(1);
    const draftId = minted[0]?.id ?? "";
    expect(draftSettings(draftId)?.harnessId).toBe("codex");
    expect(draftSettings(draftId)?.model).toBe("gpt-6-astra");

    // The page binds the new draft, and the host answers Claude's models.
    host.claudeModelsLoaded = true;
    view.rerender(
      <LandingComposer
        draftId={draftId}
        pendingCreateId={null}
        initialSettings={draftSettings(draftId)}
        workspaceControls={() => null}
      />,
    );
    await waitFor(() =>
      expect(draftSettings(draftId)?.model).toBe("sonnet-5.5"),
    );
    expect(draftSettings(draftId)?.harnessId).toBe("claude");
    expect(lastRunSettings()).toBe(lastRun);
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
  });

  it("drops an owed write once the stage is gone, and leaves the draft on its own pick", async () => {
    host.claudeModelsLoaded = false;
    const draftId = useLandingDraftStore.getState().createDraft(TRAYCER_PICK);
    const before = draftSettings(draftId);
    const view = mount(draftId, before);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    // Adopted, but owed: Claude has no model to write yet.
    expect(toolbar().getState().values.selection.harnessId).toBe("claude");
    expect(draftSettings(draftId)).toBe(before);

    act(() => {
      useStagedSandboxStore.getState().clear(SURFACE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(false),
    );

    // The host now runs Codex instead, and Codex's models are there.
    host.harnesses = {
      harnesses: [
        { id: "claude", available: false },
        { id: "codex", available: true },
        { id: "traycer", available: false },
      ],
    };
    view.rerender(
      <LandingComposer
        draftId={draftId}
        pendingCreateId={null}
        initialSettings={before}
        workspaceControls={() => null}
      />,
    );
    await waitFor(() =>
      expect(toolbar().getState().selection.modelSlug).toBe("gpt-6-astra"),
    );

    expect(draftSettings(draftId)).toBe(before);
  });

  it("drops an owed write once the stage is gone, though its harness is still presented", async () => {
    host.claudeModelsLoaded = false;
    const draftId = useLandingDraftStore.getState().createDraft(TRAYCER_PICK);
    const before = draftSettings(draftId);
    const view = mount(draftId, before);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    // Adopted, but owed: Claude has no model to write yet.
    expect(toolbar().getState().values.selection.harnessId).toBe("claude");
    expect(draftSettings(draftId)).toBe(before);

    act(() => {
      useStagedSandboxStore.getState().clear(SURFACE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(false),
    );

    // Claude is still the harness shown, and now its models arrive.
    host.claudeModelsLoaded = true;
    view.rerender(
      <LandingComposer
        draftId={draftId}
        pendingCreateId={null}
        initialSettings={before}
        workspaceControls={() => null}
      />,
    );
    await waitFor(() =>
      expect(toolbar().getState().selection.modelSlug).toBe("sonnet-5.5"),
    );

    expect(toolbar().getState().selection.harnessId).toBe("claude");
    expect(draftSettings(draftId)).toBe(before);
  });

  describe("with a Traycer model the sandbox's own list leaves out", () => {
    const PICK_A: ChatRunSettings = {
      ...PICK,
      harnessId: "traycer",
      model: "trc-a",
      reasoningEffort: null,
    };

    /** Traycer runs on this host and lists model A; the sandbox's list is `cloud`. */
    async function stageAndPressSend(
      cloud: ReadonlyArray<string> | undefined,
      fetching: boolean,
    ) {
      host.harnesses = {
        harnesses: [
          { id: "claude", available: true },
          { id: "codex", available: false },
          { id: "traycer", available: true },
        ],
      };
      host.traycerHostModels = [{ slug: "trc-a", label: "Traycer A" }];
      host.cloudModels = cloud;
      host.cloudFetching = fetching;
      const draftId = useLandingDraftStore.getState().createDraft(PICK_A);
      const before = draftSettings(draftId);
      const view = mount(draftId, before);
      await waitFor(() =>
        expect(chipModelName(toolbar().getState())).toBe("Traycer A"),
      );
      act(() => {
        useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
      });
      await waitFor(() =>
        expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
      );
      act(() => {
        host.installEditor?.();
        host.snapshot?.();
      });
      view.rerender(composer(draftId, before));
      return { draftId, before, view };
    }

    function send() {
      return userEvent.click(
        screen.getByRole("button", { name: "Submit landing" }),
      );
    }

    it("refuses it at Send with the sandbox's line and three remedies, creating nothing and keeping the chip and draft", async () => {
      const { draftId, before } = await stageAndPressSend(["trc-s"], false);
      // The stage never moves the chip off the model on screen.
      expect(chipModelName(toolbar().getState())).toBe("Traycer A");

      await send();

      const notice = within(await screen.findByRole("alert"));
      expect(
        notice.getByText(
          "Traycer A doesn't run on this sandbox. Choose another Traycer model to run agents here.",
        ),
      ).toBeDefined();
      // The notice's icon-only dismiss button has no label; the actions do.
      expect(
        notice
          .getAllByRole("button")
          .map((b) => b.textContent)
          .filter((label) => label !== ""),
      ).toEqual([
        "Choose a model",
        "Open terminal instead",
        "Use This computer",
      ]);
      expect(host.startTask).not.toHaveBeenCalled();
      expect(host.submit).not.toHaveBeenCalled();
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(draftSettings(draftId)).toBe(before);
      expect(chipModelName(toolbar().getState())).toBe("Traycer A");
      expect(pickedRunSettings(toolbar().getState()).model).toBe("trc-a");
    });

    it("takes the stage off with the action named for the composer's host", async () => {
      const { draftId, before } = await stageAndPressSend(["trc-s"], false);
      await send();
      const notice = within(await screen.findByRole("alert"));

      await userEvent.click(
        notice.getByRole("button", { name: "Use This computer" }),
      );

      expect(
        useStagedSandboxStore.getState().bySurface[SURFACE],
      ).toBeUndefined();
      expect(host.startTask).not.toHaveBeenCalled();
      expect(draftSettings(draftId)).toBe(before);
    });

    it("says Use another host when the directory has no row for the composer's host", async () => {
      host.directoryNamesHost = false;
      await stageAndPressSend(["trc-s"], false);
      await send();
      const notice = within(await screen.findByRole("alert"));

      expect(
        notice.getByRole("button", { name: "Use another host" }),
      ).toBeDefined();
      expect(notice.queryByRole("button", { name: /^Use This/ })).toBeNull();
    });

    it("lets a model the sandbox's list holds go through", async () => {
      await stageAndPressSend(["trc-a", "trc-s"], false);

      await send();

      await waitFor(() => expect(host.startTask).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("holds Send behind the checking notice while the sandbox's list loads, and refuses nothing", async () => {
      await stageAndPressSend(undefined, true);

      expect(screen.getByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Submit landing" }),
      ).toHaveProperty("disabled", true);
      expect(host.startTask).not.toHaveBeenCalled();
      expect(screen.queryByText(/doesn't run on this sandbox/)).toBeNull();
    });
  });
});
