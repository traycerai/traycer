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
  binding: null as LandingBinding | null,
  startTask: vi.fn(),
  submit: vi.fn(),
  clearEditor: vi.fn(),
}));

interface LandingBinding extends RestingBinding {
  /** No named host has a client here: the staged send repairs nothing. */
  readonly hostClient: { readonly createRequesterForHostId: () => null };
}

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
      options: slugs.map((slug) => ({
        ...modelOption("traycer", slug),
        label: slug === "trc-a" ? "Traycer A" : slug,
      })),
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
vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const { restingDirectory: directory } =
      await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
    return {
      ...(await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >()),
      readHostDirectoryEntry: directory.read,
      subscribeHostRowChanged: directory.subscribe,
    };
  },
);
vi.mock("@/lib/host", () => ({
  useHostBinding: () => host.binding,
  useHostClient: () => null,
  useHostDirectory: () => host.binding?.directory,
  useHostRuntimeClient: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async () => {
  const { useRestingDirectoryEntry } =
    await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
  return { useHostDirectoryEntry: useRestingDirectoryEntry };
});
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
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useHostPickRequestStore } from "@/stores/composer/host-pick-request-store";
import { chipModelName } from "@/stores/composer/composer-toolbar-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

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

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
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

import { readStagedSandbox } from "@/stores/composer/staged-sandbox-store";
import userEventLib from "@testing-library/user-event";

function restingSummary(state: "suspended" | "stopped" | "awake") {
  return sandboxSummaryFixture({
    id: "sbx_rest",
    hostId: HOST_ID,
    displayName: "Laptop box",
    state,
  });
}

/** The sandbox the composer sits on, in the directory and in the cloud's list. */
function rest(state: "suspended" | "stopped" | "awake"): void {
  restingDirectory.setSandbox(HOST_ID, "Laptop box", state);
  host.binding?.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: { sandboxes: [restingSummary(state)] },
    }),
  );
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
  host.binding = {
    ...createRestingBinding([]),
    hostClient: { createRequesterForHostId: () => null },
  };
  restingDirectory.clear();
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
  useHostPickRequestStore.setState({ bySurface: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().setGlobalRunSettings(HOST_ID, PICK, 1);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
});

afterEach(() => {
  cleanup();
  restingDirectory.clear();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a landing composer on a sandbox that rests", () => {
  it.each([
    { state: "suspended", verb: "resume" },
    { state: "stopped", verb: "start" },
  ] as const)(
    "stages a $state sandbox it finds no stage for, and Send takes that stage",
    async ({ state, verb }) => {
      rest(state);
      const draftId = useLandingDraftStore.getState().createDraft(PICK);
      const view = mount(draftId, draftSettings(draftId));
      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          kind: "existing",
          hostId: HOST_ID,
          sandboxId: "sbx_rest",
          verb,
        }),
      );
      act(() => {
        host.installEditor?.();
        host.snapshot?.();
      });
      view.rerender(composer(draftId, draftSettings(draftId)));

      await userEventLib.click(
        screen.getByRole("button", { name: "Submit landing" }),
      );

      await waitFor(() => expect(host.startTask).toHaveBeenCalledTimes(1));
      // The send waits on the sandbox's wake as a pending send of its own.
      const sends = Object.values(usePendingSandboxSendStore.getState().sends);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.epicId).toBe("epic-new");
      const taken = Object.values(
        useStagedSandboxStore.getState().bySurface,
      ).filter((stage) => stage?.sendTaken === true);
      expect(taken).toHaveLength(1);
      expect(taken[0]?.target).toMatchObject({
        hostId: HOST_ID,
        sandboxId: "sbx_rest",
        verb,
      });
    },
  );
  it("stages the draft's returned sandbox and not the resting host the composer sits on", async () => {
    rest("suspended");
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    useLandingDraftStore.getState().setDraftReturnedSandbox(draftId, {
      target: {
        kind: "existing",
        hostId: "host-returned",
        sandboxId: "sbx_returned",
        name: "Returned box",
        configuration: { kind: "personal" },
        verb: "start",
      },
      clientRequestId: "accepted-create-key",
    });

    // The sandbox list is already read, so the resting stage could land on mount.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (host.binding !== null)
      queryClient.setQueryData(
        sandboxQueryKeys.list(host.binding.auth, "user-a"),
        {
          sandboxes: [restingSummary("suspended")],
        },
      );
    renderComponent(composer(draftId, draftSettings(draftId)), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: "host-returned",
      }),
    );
    await act(() => Promise.resolve());
    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      hostId: "host-returned",
    });
  });

  it("keeps the model's name on the chip through Send, once the sandbox's list stops holding it", async () => {
    rest("suspended");
    host.harnesses = {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: false },
        { id: "traycer", available: true },
      ],
    };
    host.cloudModels = ["trc-a"];
    const draftId = useLandingDraftStore.getState().createDraft({
      ...PICK,
      harnessId: "traycer",
      model: "trc-a",
      reasoningEffort: null,
    });
    const view = mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(chipModelName(toolbar().getState())).toBe("Traycer A"),
    );
    await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());
    act(() => {
      host.installEditor?.();
      host.snapshot?.();
    });
    view.rerender(composer(draftId, draftSettings(draftId)));
    await userEventLib.click(
      screen.getByRole("button", { name: "Submit landing" }),
    );
    await waitFor(() => expect(host.startTask).toHaveBeenCalledTimes(1));

    host.cloudModels = ["trc-s"];
    view.rerender(composer(draftId, draftSettings(draftId)));

    await act(() => Promise.resolve());
    expect(chipModelName(toolbar().getState())).toBe("Traycer A");
  });

  describe("with a Traycer model the sandbox's own list leaves out", () => {
    const PICK_A: ChatRunSettings = {
      ...PICK,
      harnessId: "traycer",
      model: "trc-a",
      reasoningEffort: null,
    };
    const RETURNED_ELSEWHERE = {
      target: {
        kind: "existing",
        hostId: "host-returned",
        sandboxId: "sbx_returned",
        name: "Returned box",
        configuration: { kind: "personal" },
        verb: "start",
      },
      clientRequestId: "accepted-create-key",
    } as const;

    async function pressSend(returned: boolean) {
      rest("suspended");
      host.harnesses = {
        harnesses: [
          { id: "claude", available: true },
          { id: "codex", available: false },
          { id: "traycer", available: true },
        ],
      };
      host.traycerHostModels = [{ slug: "trc-a", label: "Traycer A" }];
      host.cloudModels = ["trc-s"];
      // Another host listed it earlier on this device; this sandbox's list leaves it out.
      useComposerHarnessMemoryStore
        .getState()
        .recordModelName("traycer", "trc-a", "Traycer A");
      const draftId = useLandingDraftStore.getState().createDraft(PICK_A);
      if (returned)
        useLandingDraftStore
          .getState()
          .setDraftReturnedSandbox(draftId, RETURNED_ELSEWHERE);
      const before = draftSettings(draftId);
      const view = mount(draftId, before);
      await waitFor(() =>
        expect(chipModelName(toolbar().getState())).toBe("Traycer A"),
      );
      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          hostId: returned ? "host-returned" : HOST_ID,
        }),
      );
      act(() => {
        host.installEditor?.();
        host.snapshot?.();
      });
      view.rerender(composer(draftId, before));
      await userEventLib.click(
        screen.getByRole("button", { name: "Submit landing" }),
      );
      return within(await screen.findByRole("alert"));
    }

    it("offers another host, and opens the host picker rather than leaving the sandbox it sits on", async () => {
      const notice = await pressSend(false);
      expect(
        notice.getByText(
          "Traycer A doesn't run on this sandbox. Choose another Traycer model to run agents here.",
        ),
      ).toBeDefined();
      expect(notice.queryByRole("button", { name: /^Use This/ })).toBeNull();
      const staged = readStagedSandbox(SURFACE);

      await userEventLib.click(
        notice.getByRole("button", { name: "Use another host" }),
      );

      expect(useHostPickRequestStore.getState().bySurface[SURFACE]).toBe(1);
      expect(readStagedSandbox(SURFACE)).toBe(staged);
    });

    it("names the composer's host and takes the stage off when the stage is on another", async () => {
      const notice = await pressSend(true);
      // The draft's returned sandbox takes the stage, not the resting host.
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: "host-returned",
      });

      await userEventLib.click(
        notice.getByRole("button", { name: "Use This computer" }),
      );

      // The stage is off the other host; the composer's own rests, so it stages that.
      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          hostId: HOST_ID,
        }),
      );
      expect(useHostPickRequestStore.getState().bySurface[SURFACE]).toBe(
        undefined,
      );
    });
  });
});
