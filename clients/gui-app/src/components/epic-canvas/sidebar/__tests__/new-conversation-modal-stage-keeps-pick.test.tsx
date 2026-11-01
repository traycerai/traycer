import { useRef, useState, type ReactNode } from "react";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

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
  /** The sandbox's own Traycer list: `undefined` while it loads. */
  cloudModels: undefined as ReadonlyArray<string> | undefined,
  /** The host's Traycer list, by slug and chip label. */
  traycerHostModels: [{ slug: "traycer-default", label: "traycer-default" }],
  createChat: vi.fn(),
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

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => {
    if (harnessId === "claude") return { data: CLAUDE_MODELS };
    return { data: harnessId === "traycer" ? traycerHostList() : CODEX_MODELS };
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  // The query's own shape: a read that has not answered is pending.
  useSandboxTraycerModels: () => {
    const data = cloudModelOptions();
    return {
      data,
      isPending: data === undefined,
      isFetching: false,
      fetchStatus: "idle" as const,
      isError: false,
    };
  },
}));
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
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
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
vi.mock("@/lib/host", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/lib/host/runtime", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-a",
        kind: "local",
        label: "Laptop",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));
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
    }),
  },
}));
vi.mock("@/stores/epics/initial-chat-handoff-store", () => ({
  useInitialChatHandoffStore: {
    getState: () => ({
      register: vi.fn(),
      markInitialTurnStarted: vi.fn(),
      markFailedByAction: vi.fn(),
    }),
  },
}));

import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import { chipModelName } from "@/stores/composer/composer-toolbar-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
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

const NEW_STAGE: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "",
  wakeString: null,
};

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

function Harness() {
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
              hostId={null}
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

function renderModal(): RenderResult {
  return render(<Harness />, { wrapper: QueryWrapper });
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
  host.cloudModels = undefined;
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
  useStagedSandboxStore.setState({ bySurface: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
  useNewConversationModalStore.getState().setSettings(EPIC_ID, PICK);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useNewConversationModalStore.getState().resetForTests();
});

describe("a new-conversation modal with a sandbox staged", () => {
  it("writes the kept pick to its draft and not to the harness memory, and shows it after a reload", async () => {
    const first = renderModal();
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    expect(draftSettings()?.harnessId).toBe("codex");

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });

    await waitFor(() => expect(draftSettings()?.harnessId).toBe("claude"));
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});

    // The reload: a stage is in memory only, so the store starts empty and the
    // draft's give-back record restores it.
    first.unmount();
    host.toolbar = null;
    useStagedSandboxStore.setState({ bySurface: {} });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-a", username: "user-a" },
    });
    useNewConversationModalStore.getState().setReturnedSandbox(EPIC_ID, {
      target: NEW_STAGE,
      clientRequestId: null,
    });
    renderModal();
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(toolbar().getState().selection.harnessId).toBe("claude");
    expect(pickedRunSettings(toolbar().getState()).harnessId).toBe("claude");
  });

  it("refuses a Traycer model the sandbox's list leaves out at Send, keeping the chip and draft and creating nothing", async () => {
    host.harnesses = {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: false },
        { id: "traycer", available: true },
      ],
    };
    host.traycerHostModels = [{ slug: "trc-a", label: "Traycer A" }];
    host.cloudModels = ["trc-s"];
    useNewConversationModalStore.getState().setSettings(EPIC_ID, {
      ...PICK,
      harnessId: "traycer",
      model: "trc-a",
      reasoningEffort: null,
    });
    renderModal();
    await waitFor(() =>
      expect(chipModelName(toolbar().getState())).toBe("Traycer A"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    // The stage never moves the chip off the model on screen.
    expect(chipModelName(toolbar().getState())).toBe("Traycer A");
    const draft = draftSettings();
    act(() => {
      host.installEditor?.();
    });

    act(() => {
      host.bodySubmit?.();
    });

    const notice = within(await screen.findByTestId("composer-host-notice"));
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
    ).toEqual(["Choose a model", "Open terminal instead", "Use Laptop"]);
    expect(host.createChat).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(draftSettings()).toBe(draft);
    expect(chipModelName(toolbar().getState())).toBe("Traycer A");
    expect(pickedRunSettings(toolbar().getState()).model).toBe("trc-a");
  });
});
