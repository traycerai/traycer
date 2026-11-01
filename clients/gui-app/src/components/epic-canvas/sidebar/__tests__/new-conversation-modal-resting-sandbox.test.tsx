import { useRef, useState, type ReactNode } from "react";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { SandboxStagingSurface } from "@/components/composer/use-sandbox-staging";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

// What the host can run: the person's Codex pick is not among it, so Claude
// is shown.
const host = vi.hoisted(() => ({
  harnesses: {
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: false },
    ],
  },
  toolbar: null as ComposerToolbarStore | null,
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  sandboxStaging: null as SandboxStagingSurface | null,
  /** The cloud's Traycer list, as the window's `AuthService` answers it. */
  cloudModels: [] as ReadonlyArray<string>,
  binding: null as RestingBinding | null,
  /** The host's Traycer list, by slug and chip label. */
  traycerHostModels: [{ slug: "traycer-default", label: "traycer-default" }],
  createChat: vi.fn(),
  /** Whether the body would let Send through. */
  canSubmit: false,
  navigate: vi.fn(),
  /** Every toast the modal raised, with its action's label. */
  toasts: [] as Array<{
    readonly message: string;
    readonly action: {
      readonly label: string;
      readonly onClick: () => void;
    } | null;
  }>,
  handoffFailures: [] as Array<{ readonly chatId: string }>,
}));

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
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => {
    if (harnessId === "claude") return { data: CLAUDE_MODELS };
    return { data: harnessId === "traycer" ? traycerHostList() : CODEX_MODELS };
  },
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
vi.mock("@/hooks/host/use-host-directory-entry", async () => {
  const { useRestingDirectoryEntry } =
    await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
  return { useHostDirectoryEntry: useRestingDirectoryEntry };
});
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [] },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
// The awake sandbox's own agents are installed and ready.
const READY_PROVIDERS = vi.hoisted(() => ({
  list: null as { readonly providers: ReadonlyArray<ProviderCliState> } | null,
}));
vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => {
    const { providerRow } =
      await import("@/lib/sandboxes/__tests__/pending-send-fixtures");
    READY_PROVIDERS.list = {
      providers: [providerRow("claude-code", { status: "installed" })],
    };
    return {
      ...(await importOriginal<
        typeof import("@/hooks/providers/use-providers-list-query")
      >()),
      useProvidersListForClient: () => ({
        data: READY_PROVIDERS.list,
        isError: false,
      }),
    };
  },
);
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

// The editor and toolbar chrome are held by their own suites; the body hands
// back the real toolbar store the modal built.
vi.mock("@/components/home/composer/composer-body", () => ({
  ComposerBody: (props: ComposerBodyProps) => {
    host.toolbar = props.toolbarStore;
    host.bodySubmit = props.onSubmit;
    host.canSubmit = props.canSubmit;
    host.installEditor = () => {
      props.editorRef.current = editorHandle();
    };
    return (
      <>
        {props.workspaceControls}
        {props.topBanner}
      </>
    );
  },
}));

const stubHostClient = {
  getActiveHostId: () => "host-a",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => {
    const target = {
      resolvedHostId: "host-a",
      client: stubHostClient,
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    return {
      pin: {
        selection: null,
        honoredSelection: null,
        setSelection: () => undefined,
        resolvedHostId: "host-a",
        isPinned: false,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => "Studio Mac",
      followsEffective: true,
    };
  },
}));
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxSend: () => ({ intercept: () => false, line: null }),
  useStagedSandboxHandoff: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => ({
  useTeamSandboxHarnessGate: () => () => false,
  useTeamSandboxHarnessBlocked: () => false,
}));
vi.mock("@/hooks/composer/use-composer-mirror-line", () => ({
  useComposerMirrorLine: () => ({ notice: null, markSeen: () => undefined }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-session",
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    mutateAsync: host.createChat,
  }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({ isPending: false, create: vi.fn() }),
}));
vi.mock("@/lib/composer/repointed-staging-toast", () => ({
  toastRepointedStagingReset: () => undefined,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicTitle: () => "Epic",
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => stubHostClient,
  useHostBinding: () => host.binding,
}));
vi.mock("@/lib/host/runtime", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({
    hosts: [
      hostScopeOptionFixture({
        hostId: "host-a",
        name: "Laptop",
        isLocalMachine: false,
      }),
    ],
  });
  return { useHostOptions: () => options };
});
vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () => null,
  latestCreatedConversationOwner: () => null,
}));
vi.mock("@/hooks/worktree/use-owner-workspace-inheritance-seed", () => ({
  useOwnerWorkspaceInheritanceSeed: () => ({ seed: null }),
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: () => ({
    chats: { byId: {}, allIds: [] },
    tuiAgents: { byId: {}, allIds: [] },
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
    },
  }),
}));
vi.mock("@/hooks/composer/use-composer-paste", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/composer/use-composer-paste")
  >("@/hooks/composer/use-composer-paste");
  const stubPasteResult = () => ({
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
  });
  return {
    ...actual,
    useComposerPaste: stubPasteResult,
    useComposerHashPaste: stubPasteResult,
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
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  mentionRootsFromWorktreeIntent: () => [],
  useWorkspaceMentionRoots: () => [],
}));
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: (props: {
      readonly sandboxStaging: SandboxStagingSurface | null;
    }) => {
      host.sandboxStaging = props.sandboxStaging;
      return null;
    },
  }),
);
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useEpicImageFetcher: () => vi.fn(),
  useEpicAttachmentBytesPresence: () => null,
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => ({
      markChatTitlePending: vi.fn(),
      clearChatTitlePending: vi.fn(),
      resolveTargetTabForEpic: () => "tab-1",
    }),
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => host.navigate,
}));
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(
      (
        message: string,
        options: {
          readonly action?: {
            readonly label: string;
            readonly onClick: () => void;
          };
        },
      ): string => {
        host.toasts.push({ message, action: options.action ?? null });
        return message;
      },
      actual.toast,
    ),
  };
});
vi.mock("@/stores/epics/initial-chat-handoff-store", () => ({
  useInitialChatHandoffStore: {
    getState: () => ({
      register: vi.fn(),
      markInitialTurnStarted: vi.fn(),
      markFailedByAction: (_key: unknown, chatId: string) => {
        host.handoffFailures.push({ chatId });
      },
    }),
  },
}));

import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { CHECKING_SANDBOX_AGENTS } from "@/lib/sandboxes/sandbox-strings";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { harnessRow } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";
import { chipModelName } from "@/stores/composer/composer-toolbar-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostPickRequestStore } from "@/stores/composer/host-pick-request-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";

const EPIC_ID = "epic-1";
const SURFACE = newConversationSurfaceKey(EPIC_ID);

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

// A sandbox an earlier Send of this draft gave back, under its accepted key.
const RETURNED = {
  userId: "user-a",
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

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

function Harness({ hostId }: { readonly hostId: string | null }) {
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  return (
    <SurfacePresentationBoundary visible focused>
      <Dialog open>
        <DialogContent>
          <NewConversationTransientContext.Provider value={transient}>
            <NewConversationModalBody
              epicId={EPIC_ID}
              tabId="tab-1"
              placement={null}
              parentId={null}
              hostId={hostId}
              dismissPickerRef={dismissPickerRef}
              onSubmitted={vi.fn()}
            />
          </NewConversationTransientContext.Provider>
        </DialogContent>
      </Dialog>
    </SurfacePresentationBoundary>
  );
}

function QueryWrapper({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createAppQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function restingSandboxSummary(): SandboxSummary {
  return sandboxSummaryFixture({
    id: "sbx_rest",
    hostId: "host-a",
    displayName: "Laptop box",
    state: "suspended",
  });
}

/** The sandbox list already answered, so the resting stage can land on mount. */
function ListCachedQueryWrapper({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [client] = useState(() => {
    const queryClient = createAppQueryClient();
    if (host.binding !== null)
      queryClient.setQueryData(
        sandboxQueryKeys.list(host.binding.auth, "user-a"),
        { sandboxes: [restingSandboxSummary()] },
      );
    return queryClient;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderModal(): RenderResult {
  return render(<Harness hostId={null} />, { wrapper: QueryWrapper });
}

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => DIRTY_CONTENT,
    isEmpty: () => false,
    clear: () => undefined,
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

function toolbar(): ComposerToolbarStore {
  if (host.toolbar === null) throw new Error("the modal did not mount");
  return host.toolbar;
}

function draftSettings(): ChatRunSettings | null | undefined {
  return useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
    ?.settings;
}

beforeEach(() => {
  localStorage.clear();
  host.toolbar = null;
  host.bodySubmit = null;
  host.installEditor = null;
  host.sandboxStaging = null;
  host.cloudModels = [];
  host.binding = createRestingBinding([]);
  restingDirectory.clear();
  restingDirectory.setSandbox("host-a", "Laptop box", "suspended");
  host.binding.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: { sandboxes: [restingSandboxSummary()] },
    }),
  );
  usePendingSandboxSendStore.setState({ sends: {} });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  host.harnesses = {
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: false },
    ],
  };
  host.traycerHostModels = [
    { slug: "traycer-default", label: "traycer-default" },
  ];
  host.createChat.mockReset();
  host.navigate.mockReset();
  host.toasts.length = 0;
  host.handoffFailures.length = 0;
  host.canSubmit = false;
  useStagedSandboxStore.setState({ bySurface: {} });
  useHostPickRequestStore.setState({ bySurface: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
  useNewConversationModalStore.getState().setSettings(EPIC_ID, PICK);
});

afterEach(() => {
  cleanup();
  restingDirectory.clear();
  usePendingSandboxSendStore.setState({ sends: {} });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useNewConversationModalStore.getState().resetForTests();
});

/** The cloud's Traycer list, as the window's `AuthService` answers it. */
function cloudLists(...slugs: ReadonlyArray<string>): void {
  host.binding?.auth.getTraycerModels.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      models: slugs.map((slug) => ({
        ...modelOption("traycer", slug),
        deprecationNotice: null,
      })),
    }),
  );
}

function pickTraycer(model: string): void {
  host.harnesses = {
    harnesses: [
      { id: "claude", available: true },
      { id: "traycer", available: true },
    ],
  };
  host.traycerHostModels = [{ slug: model, label: model }];
  useNewConversationModalStore.getState().setSettings(EPIC_ID, {
    ...PICK,
    harnessId: "traycer",
    model,
    reasoningEffort: null,
  });
}

describe("a new-conversation modal on a host that rests", () => {
  it("stages the resting host and hands the picked Traycer model to the pending send at Send", async () => {
    pickTraycer("trc-s");
    cloudLists("trc-s", "trc-t");
    renderModal();
    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        kind: "existing",
        hostId: "host-a",
        sandboxId: "sbx_rest",
        verb: "resume",
      }),
    );
    await waitFor(() =>
      expect(toolbar().getState().sandboxRunTarget).toBe("staged"),
    );
    act(() => {
      host.installEditor?.();
    });

    act(() => {
      host.bodySubmit?.();
    });

    await waitFor(() =>
      expect(
        Object.keys(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1),
    );
    const [send] = Object.values(usePendingSandboxSendStore.getState().sends);
    expect(send.epicId).toBe(EPIC_ID);
    expect(send.settings).toMatchObject({
      harnessId: "traycer",
      model: "trc-s",
    });
    expect(host.createChat).not.toHaveBeenCalled();
  });

  it("restores the draft's returned sandbox ahead of the resting host, and Send adopts its create key", async () => {
    pickTraycer("trc-s");
    cloudLists("trc-s");
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, RETURNED);
    render(<Harness hostId={null} />, { wrapper: ListCachedQueryWrapper });
    await waitFor(() =>
      expect(toolbar().getState().sandboxRunTarget).toBe("staged"),
    );
    act(() => {
      host.installEditor?.();
    });

    act(() => {
      host.bodySubmit?.();
    });

    await waitFor(() =>
      expect(
        Object.keys(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1),
    );
    const pending = Object.values(
      useStagedSandboxStore.getState().bySurface,
    ).find((stage) => stage?.sendTaken);
    expect(pending).toMatchObject({
      target: { hostId: "host-returned" },
      clientRequestId: "accepted-create-key",
    });
  });

  it("stages the resting host once the draft forgets its returned sandbox", async () => {
    pickTraycer("trc-s");
    cloudLists("trc-s");
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, RETURNED);
    render(<Harness hostId={null} />, { wrapper: ListCachedQueryWrapper });
    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: "host-returned",
      }),
    );

    act(() => {
      useNewConversationModalStore.getState().setReturnedSandbox(EPIC_ID, null);
    });

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: "host-a",
      }),
    );
  });

  it("stages the host a modal names, whatever sandbox the task's draft holds", async () => {
    pickTraycer("trc-s");
    cloudLists("trc-s");
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, RETURNED);
    render(<Harness hostId="host-a" />, { wrapper: ListCachedQueryWrapper });

    await waitFor(() =>
      expect(toolbar().getState().sandboxRunTarget).toBe("staged"),
    );
    expect(
      Object.values(useStagedSandboxStore.getState().bySurface).map(
        (stage) => stage?.target,
      ),
    ).toEqual([expect.objectContaining({ hostId: "host-a" })]);
  });

  it("reads no sandbox list and stages nothing on a host that is awake", async () => {
    restingDirectory.setSandbox("host-a", "Laptop box", "awake");
    renderModal();
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBeDefined(),
    );
    await act(() => Promise.resolve());

    expect(host.binding?.auth.listSandboxes).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(toolbar().getState().sandboxRunTarget).toBeNull();
  });

  it("refuses a Traycer model the cloud's list leaves out at Send, handing nothing and waking nothing", async () => {
    pickTraycer("trc-a");
    cloudLists("trc-s");
    renderModal();
    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: "host-a",
      }),
    );
    await waitFor(() =>
      expect(chipModelName(toolbar().getState())).toBe("Traycer model"),
    );
    act(() => {
      host.installEditor?.();
    });
    const draft = draftSettings();

    act(() => {
      host.bodySubmit?.();
    });

    const notice = within(await screen.findByTestId("composer-host-notice"));
    expect(
      notice.getByText(
        "Traycer model doesn't run on this sandbox. Choose another Traycer model to run agents here.",
      ),
    ).toBeDefined();
    expect(
      notice.getByRole("button", { name: "Choose a model" }),
    ).toBeDefined();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SURFACE)).toMatchObject({ phase: "staged" });
    expect(host.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
    expect(host.createChat).not.toHaveBeenCalled();
    expect(draftSettings()).toBe(draft);
    expect(toolbar().getState().selection.modelSlug).toBe("trc-a");
  });

  it("stages a stopped sandbox with the start verb", async () => {
    restingDirectory.setSandbox("host-a", "Laptop box", "stopped");
    host.binding?.auth.listSandboxes.mockImplementation(() =>
      Promise.resolve({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({
              id: "sbx_rest",
              hostId: "host-a",
              displayName: "Laptop box",
              state: "stopped",
            }),
          ],
        },
      }),
    );
    renderModal();

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        kind: "existing",
        hostId: "host-a",
        sandboxId: "sbx_rest",
        verb: "start",
      }),
    );
  });

  describe("when Send is refused for a Traycer model the sandbox's list leaves out", () => {
    async function refused(hostId: string | null) {
      pickTraycer("trc-a");
      cloudLists("trc-s");
      render(<Harness hostId={hostId} />, { wrapper: QueryWrapper });
      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          hostId: "host-a",
        }),
      );
      act(() => {
        host.installEditor?.();
      });
      act(() => {
        host.bodySubmit?.();
      });
      return within(await screen.findByTestId("composer-host-notice"));
    }

    it("offers another host, which opens the host picker and keeps the stage", async () => {
      const notice = await refused(null);
      const staged = readStagedSandbox(SURFACE);

      fireEvent.click(notice.getByRole("button", { name: "Use another host" }));

      expect(useHostPickRequestStore.getState().bySurface[SURFACE]).toBe(1);
      expect(readStagedSandbox(SURFACE)).toBe(staged);
    });

    it("offers no host to leave for on a modal that names its host", async () => {
      const notice = await refused("host-a");

      expect(
        notice.getByRole("button", { name: "Choose a model" }),
      ).toBeDefined();
      expect(
        notice
          .getAllByRole("button")
          .map((button) => button.textContent)
          .filter((label) => /^Use /.test(label)),
      ).toEqual([]);
    });
  });

  describe("before the sandbox list has been read", () => {
    /** The directory says the host rests; the cloud's list read has not answered. */
    function holdSandboxList() {
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
            response: { sandboxes: [restingSandboxSummary()] },
          });
        },
        fail: () => {
          answer({ kind: "network-error", detail: "list unreachable" });
        },
      };
    }

    it("holds Send with the checking line and no press, then stages on the list and sends once", async () => {
      pickTraycer("trc-s");
      cloudLists("trc-s");
      const list = holdSandboxList();
      renderModal();
      act(() => {
        host.installEditor?.();
      });

      expect(await screen.findByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();
      expect(host.canSubmit).toBe(false);
      act(() => {
        host.bodySubmit?.();
      });
      expect(host.createChat).not.toHaveBeenCalled();
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.content,
      ).toEqual(DIRTY_CONTENT);

      await act(async () => {
        list.settle();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          hostId: "host-a",
          verb: "resume",
        }),
      );
      await waitFor(() => expect(host.canSubmit).toBe(true));
      expect(screen.queryByText(CHECKING_SANDBOX_AGENTS)).toBeNull();
      act(() => {
        host.bodySubmit?.();
      });
      await waitFor(() =>
        expect(
          Object.keys(usePendingSandboxSendStore.getState().sends),
        ).toHaveLength(1),
      );
      expect(host.createChat).not.toHaveBeenCalled();
      expect(host.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
    });

    it("keeps holding Send, with the draft, when the list read is refused", async () => {
      pickTraycer("trc-s");
      cloudLists("trc-s");
      const list = holdSandboxList();
      renderModal();
      act(() => {
        host.installEditor?.();
      });
      expect(await screen.findByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();

      await act(async () => {
        list.fail();
        await Promise.resolve();
      });

      expect(screen.getByText(CHECKING_SANDBOX_AGENTS)).toBeDefined();
      expect(host.canSubmit).toBe(false);
      act(() => {
        host.bodySubmit?.();
      });
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(host.createChat).not.toHaveBeenCalled();
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.content,
      ).toEqual(DIRTY_CONTENT);
    });
  });

  describe("when the directory still says awake and the create does not happen", () => {
    const DETACHED = new RetryableTransportError({
      replaySafetyFromKey: false,
      code: "RPC_ERROR",
      message: "Host detached",
      requestId: "request-modal-detached",
      method: "epic.createChat",
      fatalDetails: {
        code: "RPC_REQUEST_TIMEOUT",
        reason: "Host detached",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });
    const SAVED_LINE = "Your message wasn't sent; it's saved in your drafts.";

    interface HeldCreate {
      readonly reject: (error: unknown) => void;
      readonly refuse: () => void;
    }

    /** The host is stale-awake in the directory, resting in the cloud; Send goes to create. */
    async function sendToAStaleAwakeHost(): Promise<HeldCreate> {
      restingDirectory.setSandbox("host-a", "Laptop box", "awake");
      host.harnesses = {
        harnesses: [harnessRow("claude", {}), harnessRow("codex", {})],
      };
      useNewConversationModalStore.getState().setSettings(EPIC_ID, {
        ...PICK,
        harnessId: "claude",
        model: "sonnet-5.5",
        reasoningEffort: null,
      });
      let rejectCreate: (error: unknown) => void = () => undefined;
      let resolveCreate: (response: unknown) => void = () => undefined;
      host.createChat.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            resolveCreate = resolve;
            rejectCreate = reject;
          }),
      );
      renderModal();
      await waitFor(() =>
        expect(toolbar().getState().selection.harnessId).toBe("claude"),
      );
      act(() => {
        host.installEditor?.();
      });
      act(() => {
        host.bodySubmit?.();
      });
      await waitFor(() => expect(host.createChat).toHaveBeenCalledTimes(1));
      // The modal clears its draft as it sends.
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.content ?? null,
      ).toBeNull();
      return {
        reject: rejectCreate,
        refuse: () => {
          resolveCreate({
            chatId: "chat-never-made",
            refusal: { kind: "host-refused" },
          });
        },
      };
    }

    function openDraftToast() {
      expect(host.toasts).toHaveLength(1);
      const [toasted] = host.toasts;
      expect(toasted.message).toBe(SAVED_LINE);
      expect(toasted.action?.label).toBe("Open draft");
      return toasted;
    }

    it("gives the message back to the draft with the toast, fails the eager tab's handoff, and sends once to the sandbox when the row rests", async () => {
      const create = await sendToAStaleAwakeHost();

      await act(async () => {
        create.reject(DETACHED);
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(
          useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
            ?.content,
        ).toEqual(DIRTY_CONTENT),
      );
      const toasted = openDraftToast();
      // The failed create marks the handoff failed by its action id.
      expect(host.handoffFailures).toHaveLength(1);

      act(() => {
        toasted.action?.onClick();
      });
      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        { epicId: EPIC_ID },
      );

      act(() => {
        restingDirectory.setSandbox("host-a", "Laptop box", "suspended");
      });
      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
          hostId: "host-a",
          verb: "resume",
        }),
      );
      await waitFor(() => expect(host.canSubmit).toBe(true));
      act(() => {
        host.bodySubmit?.();
      });
      await waitFor(() =>
        expect(
          Object.keys(usePendingSandboxSendStore.getState().sends),
        ).toHaveLength(1),
      );
      expect(host.createChat).toHaveBeenCalledTimes(1);
      expect(host.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
    });

    it("gives the message back the same way when the host refuses the create", async () => {
      const create = await sendToAStaleAwakeHost();

      await act(async () => {
        create.refuse();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(
          useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
            ?.content,
        ).toEqual(DIRTY_CONTENT),
      );
      openDraftToast();
      expect(host.handoffFailures).toHaveLength(1);
    });

    it("leaves a draft the person has started since alone, with no toast", async () => {
      const create = await sendToAStaleAwakeHost();
      const started: JsonContent = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "newer" }] },
        ],
      };
      act(() => {
        useNewConversationModalStore.getState().setContent(EPIC_ID, started);
      });

      await act(async () => {
        create.reject(DETACHED);
        await Promise.resolve();
      });

      await waitFor(() => expect(host.handoffFailures).toHaveLength(1));
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.content,
      ).toEqual(started);
      expect(host.toasts).toEqual([]);
    });

    it("restores nothing and says nothing once the account has changed", async () => {
      const create = await sendToAStaleAwakeHost();
      act(() => {
        useAuthStore
          .getState()
          .setSignedIn(
            { userId: "user-b", userName: "B", email: "b@example.com" },
            { userId: "user-b", username: "user-b" },
            [],
          );
      });

      await act(async () => {
        create.reject(DETACHED);
        await Promise.resolve();
      });

      await waitFor(() => expect(host.handoffFailures).toHaveLength(1));
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.content ?? null,
      ).toBeNull();
      expect(host.toasts).toEqual([]);
    });
  });
});
