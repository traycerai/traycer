/**
 * Retained Start Page composers share one stage surface. A stage put up on the
 * composer on screen leaves a composer that is not on screen on its own pick,
 * and that pick is what its chip, its Send and its draft keep once it is.
 */
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
  /** Each composer's toolbar store, in the order they first rendered. */
  toolbars: [] as ComposerToolbarStore[],
  editContent: null as ComposerBodyProps["onDocumentChange"] | null,
  installEditor: null as (() => void) | null,
  snapshot: null as (() => void) | null,
  /** The sandbox's own Traycer list: `undefined` while it loads. */
  cloudModels: undefined as ReadonlyArray<string> | undefined,
  cloudFetching: false,
  /** Whether the composer body draws the real model picker, whose chip a test reads. */
  renderPicker: true,
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
      if (!host.toolbars.includes(props.toolbarStore))
        host.toolbars.push(props.toolbarStore);
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

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: host.directoryNamesHost
      ? [
          {
            hostId: HOST_ID,
            kind: "local",
            label: "This computer",
            transportDialability: "dialable",
            websocketUrl: "ws://127.0.0.1:0",
          },
        ]
      : [],
  }),
}));
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
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({ hosts: [] }) };
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
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
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

beforeEach(() => {
  localStorage.clear();
  host.toolbar = null;
  host.toolbars = [];
  host.editContent = null;
  host.claudeModelsLoaded = true;
  host.cloudModels = undefined;
  host.cloudFetching = false;
  host.directoryNamesHost = true;
  host.renderPicker = true;
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

function hiddenAndVisible(
  visibleDraft: string,
  hiddenDraft: string,
  hiddenActive: boolean,
): ReactElement {
  return (
    <>
      <div data-testid="visible-composer">
        {composer(visibleDraft, draftSettings(visibleDraft))}
      </div>
      <div data-testid="hidden-composer">
        <SurfaceActivityProvider active={hiddenActive}>
          {composer(hiddenDraft, draftSettings(hiddenDraft))}
        </SurfaceActivityProvider>
      </div>
    </>
  );
}

function chipOf(testId: string) {
  return within(screen.getByTestId(testId));
}

function toolbarOf(index: number): ComposerToolbarStore {
  const store = host.toolbars.at(index);
  if (store === undefined) throw new Error("the composer did not mount");
  return store;
}

describe("a landing composer that is not on screen, with a sandbox staged", () => {
  it("keeps its own Traycer pick through the stage and after it is shown", async () => {
    const visibleDraft = useLandingDraftStore.getState().createDraft(PICK);
    const hiddenDraft = useLandingDraftStore
      .getState()
      .createDraft(TRAYCER_PICK);
    const hiddenBefore = draftSettings(hiddenDraft);
    const view = render(hiddenAndVisible(visibleDraft, hiddenDraft, false));
    await waitFor(() =>
      expect(toolbarOf(0).getState().selection.harnessId).toBe("claude"),
    );

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbarOf(0).getState().catalog.keepsUnavailablePick).toBe(true),
    );

    // The composer on screen adopted its reroute; the other one did not.
    expect(draftSettings(visibleDraft)?.harnessId).toBe("claude");
    expect(draftSettings(hiddenDraft)).toBe(hiddenBefore);
    expect(draftSettings(hiddenDraft)?.harnessId).toBe("traycer");
    const hidden = toolbarOf(1).getState();
    expect(pickedRunSettings(hidden).harnessId).toBe(
      hidden.selection.harnessId,
    );
    expect(pickedRunSettings(hidden).model).toBe(hidden.selection.modelSlug);

    // It comes on screen with the stage still up.
    view.rerender(hiddenAndVisible(visibleDraft, hiddenDraft, true));
    await waitFor(() =>
      expect(
        chipOf("hidden-composer").getByRole("button", {
          name: /^traycer-saved/,
        }),
      ).toBeDefined(),
    );

    expect(
      chipOf("hidden-composer").queryByRole("button", { name: /Select model/ }),
    ).toBeNull();
    expect(pickedRunSettings(toolbarOf(1).getState()).harnessId).toBe(
      "traycer",
    );
    expect(pickedRunSettings(toolbarOf(1).getState()).model).toBe(
      "traycer-saved",
    );
    expect(draftSettings(hiddenDraft)?.harnessId).toBe("traycer");
    expect(draftSettings(hiddenDraft)?.model).toBe("traycer-saved");
  });
});
