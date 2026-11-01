import {
  act,
  cleanup,
  render as renderComponent,
  screen,
  waitFor,
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
  createEpic: vi.fn(),
  navigate: vi.fn(),
  /** Whether the composer would let Send through. */
  canSubmit: false,
  clearEditor: vi.fn(),
}));

interface LandingBinding extends RestingBinding {
  /** No named host has a client here: the staged send repairs nothing. */
  readonly hostClient: { readonly createRequesterForHostId: () => null };
}

const PLACEMENT_CLIENT = vi.hoisted(() => ({
  hostId: "host-test",
  getActiveHostId: () => "host-test",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
}));
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

vi.mock("@/hooks/host/use-composer-placement", () => {
  const target = {
    resolvedHostId: "host-test",
    client: PLACEMENT_CLIENT,
    hostLabel: "Local",
    isPinned: false,
    namedHostDead: false,
  };
  return {
    useComposerPlacement: () => ({
      pin: {
        selection: null,
        setSelection: () => undefined,
        resolvedHostId: "host-test",
        isPinned: false,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => "Local",
    }),
  };
});
vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => SURFACE,
  }),
);
// The window's boundary for the task a Send creates: the create RPC itself.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => host.navigate,
}));
vi.mock("@/hooks/epic/use-epic-create-mutation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/epic/use-epic-create-mutation")
  >()),
  useEpicCreateForClient: () => ({
    isPending: false,
    mutateAsync: host.createEpic,
  }),
}));
vi.mock("@/hooks/epic/use-epic-attach-environment-mutation", () => ({
  useEpicAttachmentClient: () => null,
  useEpicAttachEnvironment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({ isPending: false, create: vi.fn() }),
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
    useProvidersListForClient: () => ({
      data: READY_PROVIDERS,
      isError: false,
    }),
  }),
);

import { LandingComposer } from "../landing-composer";
import {
  harnessRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { CHECKING_SANDBOX_AGENTS } from "@/lib/sandboxes/sandbox-strings";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
// Stable: a fresh list per render would push a new catalog each time.
const READY_PROVIDERS = {
  providers: [providerRow("claude-code", { status: "installed" })],
};
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import { useHostPickRequestStore } from "@/stores/composer/host-pick-request-store";
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
  host.createEpic.mockReset();
  host.navigate.mockReset();
  host.clearEditor.mockReset();
  usePendingSandboxSendStore.setState({ sends: {} });
  host.harnesses = {
    harnesses: [
      harnessRow("claude", {}),
      harnessRow("codex", { available: false }),
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

const CLAUDE_PICK: ChatRunSettings = {
  ...PICK,
  harnessId: "claude",
  model: "sonnet-5.5",
  reasoningEffort: null,
};

function submitButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: "Submit landing",
  });
}

/** A composer with the person's message typed, on a host in the given directory state. */
async function mountTyped(): Promise<{ readonly draftId: string }> {
  const draftId = useLandingDraftStore.getState().createDraft(CLAUDE_PICK);
  const view = mount(draftId, draftSettings(draftId));
  act(() => {
    host.installEditor?.();
    host.snapshot?.();
  });
  view.rerender(composer(draftId, draftSettings(draftId)));
  await waitFor(() =>
    expect(JSON.stringify(draftContent(draftId))).toContain("hello"),
  );
  return { draftId };
}

function draftContent(draftId: string): JsonContent | null | undefined {
  return useLandingDraftStore.getState().drafts.find((d) => d.id === draftId)
    ?.content;
}

describe("a landing composer on a host the directory says rests", () => {
  /** The cloud's sandbox list read has not answered. */
  function holdSandboxList() {
    restingDirectory.setSandbox(HOST_ID, "Laptop box", "suspended");
    let answer: (result: SandboxListFetchResult) => void = () => undefined;
    host.binding?.auth.listSandboxes.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    return {
      settle: () => {
        answer({
          kind: "ok",
          response: { sandboxes: [restingSummary("suspended")] },
        });
      },
      fail: () => {
        answer({ kind: "network-error", detail: "list unreachable" });
      },
    };
  }

  it("holds Send with the checking line and no press, then stages on the list and sends once", async () => {
    const list = holdSandboxList();
    const { draftId } = await mountTyped();
    const typed = draftContent(draftId);

    expect(await screen.findByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();
    expect(submitButton().disabled).toBe(true);
    await userEventLib.click(submitButton());
    expect(host.createEpic).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(draftContent(draftId)).toEqual(typed);

    await act(async () => {
      list.settle();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        kind: "existing",
        hostId: HOST_ID,
        verb: "resume",
      }),
    );
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.queryByText(CHECKING_SANDBOX_AGENTS)).toBeNull();
    host.createEpic.mockResolvedValue({ epicId: "epic-new" });
    await userEventLib.click(submitButton());
    await waitFor(() =>
      expect(
        Object.keys(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1),
    );
    expect(host.createEpic).toHaveBeenCalledTimes(1);
    expect(host.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("keeps holding Send, with the draft, when the list read is refused", async () => {
    const list = holdSandboxList();
    const { draftId } = await mountTyped();
    const typed = draftContent(draftId);
    expect(await screen.findByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();

    await act(async () => {
      list.fail();
      await Promise.resolve();
    });

    expect(screen.getByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();
    expect(submitButton().disabled).toBe(true);
    await userEventLib.click(submitButton());
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(host.createEpic).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(draftContent(draftId)).toEqual(typed);
  });
});

describe("a landing composer on a host the directory still says is awake", () => {
  const DETACHED = new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "Host detached",
    requestId: "request-landing-detached",
    method: "epic.create",
    fatalDetails: {
      code: "RPC_REQUEST_TIMEOUT",
      reason: "Host detached",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
    },
  });

  it("keeps the draft when the create is refused, and once the row rests Send goes staged and sends once", async () => {
    restingDirectory.setSandbox(HOST_ID, "Laptop box", "awake");
    host.binding?.auth.listSandboxes.mockImplementation(() =>
      Promise.resolve({
        kind: "ok",
        response: { sandboxes: [restingSummary("suspended")] },
      }),
    );
    host.createEpic.mockRejectedValueOnce(DETACHED);
    const { draftId } = await mountTyped();
    const typed = draftContent(draftId);
    await waitFor(() => expect(submitButton().disabled).toBe(false));

    await userEventLib.click(submitButton());

    await waitFor(() => expect(host.createEpic).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    // No tab was opened and the editor was not cleared: the create never landed.
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.clearEditor).not.toHaveBeenCalled();
    expect(draftContent(draftId)).toEqual(typed);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});

    act(() => {
      restingDirectory.setSandbox(HOST_ID, "Laptop box", "suspended");
    });
    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: HOST_ID,
        verb: "resume",
      }),
    );
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    host.createEpic.mockResolvedValue({ epicId: "epic-new" });
    await userEventLib.click(submitButton());

    await waitFor(() =>
      expect(
        Object.keys(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1),
    );
    expect(host.createEpic).toHaveBeenCalledTimes(2);
  });
});
