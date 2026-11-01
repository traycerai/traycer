import { useRef, useState } from "react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  readNewConversationAnnotations,
  useNewConversationAnnotationStore,
} from "@/stores/epics/new-conversation-annotation-store";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createAppQueryClient } from "@/lib/query-client";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { clearEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

// Sandbox staging has its own suites (`composer/__tests__`): here the picker
// stages nothing and the send is never intercepted.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({ hosts: [] });
  return { useHostOptions: () => options };
});
vi.mock(
  "@/components/composer/use-sandbox-staging",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/composer/use-sandbox-staging")
    >()),
    useInTaskSandboxStagingSurface: () => null,
    useSandboxStagingTask: () => ({
      hosts: null,
      groups: [],
      collaborators: null,
    }),
    useSandboxStaging: () => null,
  }),
);
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxSend: () => ({ intercept: () => false, line: null }),
  useStagedSandboxHandoff: () => undefined,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

/**
 * The new-conversation modal's browser-annotation sidecar: the cards a
 * selection sent to "New chat" brought along, the strip that shows them, and
 * the create that carries them.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const EPIC_ID = "epic-byhash";
const HOST_ID = "host-byhash";
const USER_ID = "user-byhash";

/** The slice of the `epic.createChat` request this suite reads back. */
interface RecordedInitialMessage {
  readonly content: JsonContent;
  readonly attachmentsByHash?: boolean;
  readonly browserAnnotations?: ReadonlyArray<BrowserAnnotationRecord>;
  readonly sentFromHostId?: string | null;
}

interface RecordedCreateChatRequest {
  readonly chatId: string;
  readonly hostId: string;
  readonly deferWorktreeProvisioning?: boolean;
  readonly initialMessage?: RecordedInitialMessage | null;
}

function sentInitialMessage(
  request: RecordedCreateChatRequest,
): RecordedInitialMessage {
  const message = request.initialMessage;
  if (message === null || message === undefined) {
    throw new Error("the modal dispatched a create with no initial message");
  }
  return message;
}

const testState = vi.hoisted(() => ({
  createChat: vi.fn<(request: RecordedCreateChatRequest) => Promise<unknown>>(),
  createRequests: [] as RecordedCreateChatRequest[],
  bodySubmit: null as (() => void) | null,
  installEditor: null as ((content: JsonContent) => void) | null,
  onSubmitted: vi.fn<() => void>(),
  // The directory's LOCAL host id - the machine typing, distinct from
  // `HOST_ID` (the target host the chat is created on).
  getLocalHostId: vi.fn<() => string | null>(() => "host-local-typing"),
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.installEditor = (content) => {
        props.editorRef.current = editorHandle(content);
      };
      return React.createElement(
        "div",
        null,
        props.topBanner,
        props.attachmentsStrip,
      );
    },
  };
});

function editorHandle(content: JsonContent): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  let current = content;
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => current,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: (next: JsonContent) => {
      current = next;
    },
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

type PlacementTarget = {
  readonly resolvedHostId: string;
  readonly client: {
    readonly getActiveHostId: () => string;
    readonly request: (method: string, params: unknown) => Promise<unknown>;
    readonly requestWithOptions: (
      method: string,
      params: { readonly sha256: string },
    ) => Promise<unknown>;
  };
  readonly hostLabel: string;
  readonly isPinned: boolean;
  readonly namedHostDead: boolean;
};

/**
 * A placement target bound to `hostId`; its client is a bare stand-in, since
 * these cases send the crop inline and upload nothing.
 */
function makePlacementTarget(
  hostId: string,
  hostLabel: string,
): PlacementTarget {
  return {
    resolvedHostId: hostId,
    client: {
      getActiveHostId: () => hostId,
      request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
      requestWithOptions: () => Promise.resolve({}),
    },
    hostLabel,
    isPinned: false,
    namedHostDead: false,
  };
}

const PLACEMENT_TARGET: PlacementTarget = makePlacementTarget(
  HOST_ID,
  "Byhash Host",
);

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => ({
    pin: {
      selection: null,
      honoredSelection: null,
      setSelection: () => undefined,
      resolvedHostId: PLACEMENT_TARGET.resolvedHostId,
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: PLACEMENT_TARGET,
    submitTarget: PLACEMENT_TARGET,
    hostLabelFor: () => PLACEMENT_TARGET.hostLabel,
    followsEffective: true,
  }),
}));

// The mirror line reads the task's hosts and the host registry, which this
// suite's `@/lib/host` mock does not carry; it has its own suite
// (`composer-mirror-line.test.tsx`), so here it shows nothing.
const NO_MIRROR_LINE = vi.hoisted(() =>
  Object.freeze({ notice: null, markSeen: (): void => undefined }),
);
vi.mock("@/hooks/composer/use-composer-mirror-line", () => ({
  useComposerMirrorLine: () => NO_MIRROR_LINE,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => HOST_ID,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    mutateAsync: (request: RecordedCreateChatRequest) => {
      testState.createRequests.push(request);
      return testState.createChat(request);
    },
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    isPending: false,
    create: () => Promise.resolve(null),
  }),
}));

// The agent gates read the placement host's own lists; nothing here stages a
// sandbox or sits on one, so none of them holds or refuses a send.
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => null,
    beforeSend: () => Promise.resolve(null),
  }),
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore(() => ({
    ultracode: false,
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    values: {
      selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    },
    selectedModel: null,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
    catalog: { harnesses: [] },
  }));
  return { useComposerToolbarStore: () => store };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicTitle: () => "Epic",
}));

const stubHostClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
vi.mock("@/lib/host", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => stubHostClient,
  // The create stamps `sentFromHostId` from the directory's local host.
  getHostBindingSnapshot: () => ({
    hostClient: stubHostClient,
    directory: { getLocalHostId: testState.getLocalHostId },
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
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
// The paste seam, mocked so this suite's cases never run a real ingest. Both
// hooks are stubbed because the modal calls `useComposerHashPaste`, not
// `useComposerPaste` - and `runPendingImageJob` is on the RESULT here, not on a
// separate ingest hook: `useComposerPendingImageIngest` is fed from it, so a
// stub missing that member leaves the modal wiring an undefined runner.
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
  () => ({ ActiveHostWorkspaceControls: () => null }),
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

// Local crop bytes are read through the `landing-image-store` the composers use.
const imageStoreMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  // The crop a selection captured this session; the sidecar's create reads it
  // synchronously from here.
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
}));
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    getImageBytes: imageStoreMocks.getImageBytes,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
  };
});

const CROP_HASH = "c".repeat(64);
const CROP_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function annotationRecord(): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "annotation-1",
    source: {
      kind: "canvas",
      artifactId: "canvas-1",
      artifactTitle: "Wiring",
      boardPath: "boards/home.html",
      canvasPage: null,
    },
    capturedAt: 1,
    comment: "",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: "crop.png",
    imageHash: CROP_HASH,
    droppedElementCount: 0,
  };
}

/** The client the modal's own `useQueryClient()` resolves to, fresh per test. */
let QUERY_CLIENT: QueryClient = createAppQueryClient();

function Harness() {
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const queryClient = QUERY_CLIENT;
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  return (
    <QueryClientProvider client={queryClient}>
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
                onSubmitted={testState.onSubmitted}
              />
            </NewConversationTransientContext.Provider>
          </DialogContent>
        </Dialog>
      </SurfacePresentationBoundary>
    </QueryClientProvider>
  );
}

function renderModal(content: JsonContent): RenderResult {
  const view = render(<Harness />);
  act(() => {
    testState.installEditor?.(content);
  });
  return view;
}

function submit(): void {
  act(() => {
    testState.bodySubmit?.();
  });
}

beforeEach(() => {
  QUERY_CLIENT = createAppQueryClient();
  useAuthStore.setState({
    profile: { userId: USER_ID, userName: "Tester", email: "t@example.com" },
    // The draft-blob owner id is read from `contextMetadata`, not `profile`.
    contextMetadata: { userId: USER_ID, username: USER_ID },
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode(EPIC_ID, "chat");
  useInitialChatHandoffStore.getState().resetForTests();
  testState.createRequests.length = 0;
  testState.createChat.mockReset();
  testState.createChat.mockResolvedValue({ initialTurnStarted: false });
  testState.onSubmitted.mockClear();
  testState.getLocalHostId.mockReset();
  testState.getLocalHostId.mockReturnValue("host-local-typing");
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockImplementation((hash) =>
    hash === CROP_HASH ? CROP_BYTES : null,
  );
  useNewConversationAnnotationStore.setState({ byEpicId: {} });
  resetDraftBlobTransportForTests();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null, contextMetadata: null });
  useNewConversationAnnotationStore.setState({ byEpicId: {} });
  testState.bodySubmit = null;
  testState.installEditor = null;
  useNewConversationModalStore.getState().resetForTests();
  useInitialChatHandoffStore.getState().resetForTests();
  resetNegotiatedManifests();
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
  // `pending-epic-create-seeds` has no bulk reset: clear the pairs this run minted.
  for (const request of testState.createRequests) {
    clearEpicCreateSeedPending(EPIC_ID, request.chatId);
  }
});

describe("new-conversation modal: browser-annotation sidecar", () => {
  const TEXT: JsonContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "look at this" }] },
    ],
  };

  it("shows the card in the strip", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 5 },
    });
    useNewConversationAnnotationStore
      .getState()
      .add(EPIC_ID, annotationRecord());
    renderModal(TEXT);

    expect(await screen.findByTestId("browser-annotation-cards")).toBeDefined();
  });

  it("sends the record on the first message, with its crop as the last inline image", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 5 },
    });
    const record = annotationRecord();
    useNewConversationAnnotationStore.getState().add(EPIC_ID, record);
    renderModal(TEXT);

    submit();
    await waitFor(() => expect(testState.onSubmitted).toHaveBeenCalledTimes(1));

    expect(testState.createRequests).toHaveLength(1);
    const message = sentInitialMessage(testState.createRequests[0]);
    expect(message.browserAnnotations).toEqual([record]);
    const atoms = collectImageAtoms(message.content);
    // Exactly once: the submit plans over a document with the crop appended
    // and the create appends it again, so a crop sent twice is the regression.
    expect(atoms.filter((atom) => atom.hash === CROP_HASH)).toHaveLength(1);
    expect(atoms.at(-1)?.hash).toBe(CROP_HASH);
    expect(atoms.at(-1)?.b64content).not.toBeNull();
    expect(readNewConversationAnnotations(EPIC_ID)).toEqual([]);
  });

  it("refuses inline on a host below the minor, creating nothing and keeping the card", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 4 },
    });
    const record = annotationRecord();
    useNewConversationAnnotationStore.getState().add(EPIC_ID, record);
    renderModal(TEXT);

    submit();
    expect(
      await screen.findByText(
        "Update the host to start a chat with this capture.",
      ),
    ).toBeDefined();

    expect(testState.createRequests).toHaveLength(0);
    expect(readNewConversationAnnotations(EPIC_ID)).toEqual([record]);
  });
});
