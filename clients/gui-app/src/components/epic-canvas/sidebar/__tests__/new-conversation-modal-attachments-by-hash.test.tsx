import { useRef, useState } from "react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";

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
import {
  newConversationModalStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  clearEpicCreateSeedPending,
  type EpicCreateSeedEntry,
  isEpicCreateHeld,
  isEpicCreateSeedPending,
  readEpicCreateSeed,
  releaseEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

/**
 * The in-Epic new-conversation modal's BY-HASH submit gate (items 37-40) and
 * its own copy of the generation guard (G-new-1/G-new-2) - the same
 * `settleResolvedSubmit` seam `new-conversation-submit-gate.test.tsx` already
 * pins for the COLD-READ INLINE arm, exercised here instead for the by-hash
 * upload arm, which needs its own fixture: a negotiated `epic.createChat@1.2`
 * manifest and a placement client whose `requestWithOptions` actually answers
 * `drafts.putBlob`. A fixture that skips either of those silently falls
 * through to the inline arm and proves nothing about this one.
 *
 * A separate file from `new-conversation-submit-gate.test.tsx` rather than an
 * addition to it: that file's placement mock's `client` is a bare
 * `{ getActiveHostId }` stub with no upload method, and it is being edited by
 * other work on this ticket in parallel - duplicating its large mock block
 * here keeps this suite's own fixture from colliding with that.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const EPIC_ID = "epic-byhash";
const HOST_ID = "host-byhash";
// Pin 3's destination-race case: the picker stays live through the upload
// await, and this is the OTHER host it may have moved to by the time that
// upload settles.
const HOST_ID_B = "host-byhash-b";
const USER_ID = "user-byhash";

// A real-looking sha256 hex digest - `putDraftBlobs` keys the upload's
// idempotency on the hash itself.
const BY_HASH_SHA256 =
  "1122334455667788990011223344556677889900112233445566778899aabbcc";

function byHashImageDoc(text: string): JsonContent {
  return {
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
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: BY_HASH_SHA256,
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

function byHashManyImagesDoc(count: number): JsonContent {
  const imageNodes: JsonContent[] = [];
  for (let i = 0; i < count; i++) {
    imageNodes.push({
      type: "imageAttachment",
      attrs: {
        id: `img-${String(i)}`,
        fileName: `shot-${String(i)}.png`,
        mimeType: "image/png",
        size: 4,
        byHashEligible: true,
        hash: `${BY_HASH_SHA256.slice(0, 62)}${String(i).padStart(2, "0")}`,
      },
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content: imageNodes }] };
}

/**
 * One by-hash-eligible node this window holds bytes for, plus 32 hash-only
 * nodes that are NOT eligible and have no local bytes - the shape that clears
 * the pre-upload cap check (:246, which sees only the 1-hash eligible set) and
 * must be caught by the post-inlining check (:260) instead, since inlining
 * cannot clear a hash this window never held bytes for.
 */
function mixedCapDoc(): JsonContent {
  const nodes: JsonContent[] = [
    {
      type: "imageAttachment",
      attrs: {
        id: "img-eligible",
        fileName: "shot.png",
        mimeType: "image/png",
        size: 4,
        byHashEligible: true,
        hash: BY_HASH_SHA256,
      },
    },
  ];
  for (let i = 0; i < 32; i++) {
    nodes.push({
      type: "imageAttachment",
      attrs: {
        id: `img-epic-${String(i)}`,
        fileName: `epic-${String(i)}.png`,
        mimeType: "image/png",
        size: 4,
        byHashEligible: false,
        hash: `${BY_HASH_SHA256.slice(0, 62)}${String(i).padStart(2, "0")}`,
      },
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content: nodes }] };
}

/**
 * The slice of the `epic.createChat` request this suite reads back.
 *
 * Declared once, at the recorder, rather than asserted at each read site: the
 * repo bans `as unknown` casts outright, and a per-site cast would also let two
 * cases disagree about the shape they believe the modal sent.
 *
 * `initialMessage` is `.nullable().optional()` on the wire, so it is spelled
 * that way here and narrowed by `sentInitialMessage` below. Declaring it
 * required would have been the shorter lie - TS would stop asking, and a modal
 * that shipped a null message would fail as a bare TypeError inside an
 * assertion instead of as the sentence that says what went wrong.
 */
interface RecordedInitialMessage {
  readonly content: JsonContent;
  readonly attachmentsByHash?: boolean;
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
  // Held open by `putBlobResponse` below so a test can drive exactly when the
  // upload settles relative to a mid-await edit.
  putBlobCalls: [] as Array<{
    readonly sha256: string;
    readonly hostId: string;
  }>,
  putBlobResponse: null as
    | ((response: { readonly ok: boolean }) => void)[]
    | null,
  onSubmitted: vi.fn<() => void>(),
  // The directory's LOCAL host id - the machine typing, deliberately
  // distinct from `HOST_ID`/`PLACEMENT_TARGET` (the target host the chat is
  // created on).
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
      return React.createElement("div", null, props.topBanner);
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
 * A placement target bound to `hostId`: `getActiveHostId` for the gate's
 * plumbing, plus a `request`/`requestWithOptions` pair standing in for
 * `DraftBlobClient` - a bare mock, not a real `HostClient`, since
 * `putDraftBlobs` calls these two directly and needs neither the class' own
 * idempotency-key validation nor a scheduling policy to exercise the gate.
 *
 * FACTORY rather than a single constant so Pin 3's destination-race case can
 * build a second target for a different host mid-test and swap `PLACEMENT`
 * to it - each call mints its own `requestWithOptions` mock, so a case that
 * moves the destination can tell which host an upload landed on.
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
      requestWithOptions: vi.fn(
        (method: string, params: { readonly sha256: string }) => {
          if (method !== "drafts.putBlob") return Promise.resolve({});
          testState.putBlobCalls.push({ sha256: params.sha256, hostId });
          return new Promise<{ readonly ok: boolean }>((resolve) => {
            (testState.putBlobResponse ??= []).push(resolve);
          });
        },
      ),
    },
    hostLabel,
    isPinned: false,
    namedHostDead: false,
  };
}

// The CURRENT placement, read by the mocked hook below on every render. Every
// existing case defaults this to host A by resetting it in `beforeEach`; only
// Pin 3's destination-race case reassigns it mid-test.
let PLACEMENT_TARGET: PlacementTarget = makePlacementTarget(
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

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore(() => ({
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    selectedModel: null,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
    catalog: { harnesses: [] },
  }));
  return { useComposerToolbarStore: () => store };
});

// A full-replacement factory, so it has to carry every export the rendered
// modal reaches - `useEpicTitle` arrived on `new-conversation-modal.tsx` from
// main while this file was being written on the branch, which is a gap neither
// side's diff can show: no conflict, no type error, and the three sibling
// mocks that main did update look like proof the class was swept.
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
  // The create stamps `sentFromHostId` from the directory's local host at
  // submit - see `testState.getLocalHostId` for the default and the
  // sender-host-placement cases below for the assertions.
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
  useProviderPackGate: () => ({ blocked: false, hint: null, preparing: null }),
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

// The by-hash upload path reads local bytes through the SAME
// `landing-image-store` the landing/chat composers do -
// `draft-blob-transport`'s `localBytesForHash` calls `getImageBytes`.
const imageStoreMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

const IMAGE_BYTES = new Uint8Array([9, 8, 7, 6]);

/**
 * The client the modal's own `useQueryClient()` resolves to, minted fresh per
 * test in `beforeEach`.
 *
 * Hoisted out of `Harness` (it was a `useState` initializer) so the seed-mark
 * cases can spy `invalidateQueries` on the SAME instance the registered
 * `release` closure captured. A closure that invalidates is only half the
 * claim; which key it invalidates is the other half, and a client the test
 * cannot reach makes that half unobservable.
 */
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

async function submitAndSettle(): Promise<void> {
  await act(async () => {
    testState.bodySubmit?.();
    await flushMicrotasks();
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

/** Resolve the OLDEST still-pending `drafts.putBlob` call. */
function releaseOldestPutBlob(ok: boolean): void {
  const resolve = testState.putBlobResponse?.shift();
  if (resolve === undefined)
    throw new Error("no drafts.putBlob call in flight");
  resolve({ ok });
}

beforeEach(() => {
  QUERY_CLIENT = createAppQueryClient();
  useAuthStore.setState({
    profile: { userId: USER_ID, userName: "Tester", email: "t@example.com" },
    // `currentDraftBlobOwnerId()` reads `contextMetadata.userId`, NOT
    // `profile.userId` - and a null owner CONFIRMS NOTHING, so without this the
    // upload below records no confirmation, the host-held set stays empty, the
    // modal silently falls to the inline path and every by-hash assertion in
    // this suite either reds or passes for the wrong reason.
    contextMetadata: { userId: USER_ID, username: USER_ID },
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode(EPIC_ID, "chat");
  useInitialChatHandoffStore.getState().resetForTests();
  testState.createRequests.length = 0;
  testState.createChat.mockReset();
  testState.createChat.mockResolvedValue({ initialTurnStarted: false });
  testState.putBlobCalls.length = 0;
  testState.putBlobResponse = null;
  PLACEMENT_TARGET = makePlacementTarget(HOST_ID, "Byhash Host");
  testState.onSubmitted.mockClear();
  testState.getLocalHostId.mockReset();
  testState.getLocalHostId.mockReturnValue("host-local-typing");
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  resetDraftBlobTransportForTests();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null, contextMetadata: null });
  testState.bodySubmit = null;
  testState.installEditor = null;
  useNewConversationModalStore.getState().resetForTests();
  useInitialChatHandoffStore.getState().resetForTests();
  resetNegotiatedManifests();
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
  // `pending-epic-create-seeds` keeps module-level state with no bulk reset -
  // clear every pair this run's requests minted, or a leftover mark answers
  // for the NEXT test's `readEpicCreateSeed`/`isEpicCreateHeld` reads (the
  // same class of gap `dispatchOptions` had in the landing composer suite).
  for (const request of testState.createRequests) {
    clearEpicCreateSeedPending(EPIC_ID, request.chatId);
  }
});

describe("new-conversation modal: attachments-by-hash submit gate", () => {
  it("uploads an eligible hash then ships a hash-only create on a @1.2 host", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("by hash"));

    act(() => {
      testState.bodySubmit?.();
    });
    await waitFor(() => {
      expect(testState.putBlobCalls).toHaveLength(1);
    });
    expect(testState.putBlobCalls[0]?.sha256).toBe(BY_HASH_SHA256);

    await act(async () => {
      releaseOldestPutBlob(true);
      await flushMicrotasks();
    });

    expect(testState.createRequests).toHaveLength(1);
    const message = sentInitialMessage(testState.createRequests[0]);
    expect(message.attachmentsByHash).toBe(true);
    const atoms = collectImageAtoms(message.content);
    expect(atoms[0]?.hash).toBe(BY_HASH_SHA256);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("stays on the inline path when the host has not negotiated epic.createChat@1.2", async () => {
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("inline please"));

    await submitAndSettle();

    expect(testState.putBlobCalls).toHaveLength(0);
    expect(testState.createRequests).toHaveLength(1);
    const message = sentInitialMessage(testState.createRequests[0]);
    expect(message.attachmentsByHash ?? false).toBe(false);
    const atoms = collectImageAtoms(message.content);
    expect(atoms[0]?.b64content).not.toBeNull();
  });

  // `sentFromHostId` names the machine the user is TYPING on (the local
  // host), never the target `hostId` the chat is created on (`HOST_ID`,
  // "host-byhash"). The suite's default local id ("host-local-typing")
  // already diverges from that target, so a reader quietly replaced by the
  // target host would fail this alongside one replaced by a constant.
  it("stamps the initial message's sentFromHostId with the local host id, not the target host", async () => {
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("inline please"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const request = testState.createRequests[0];
    expect(request.hostId).toBe(HOST_ID);
    const message = sentInitialMessage(request);
    expect(message.sentFromHostId).toBe("host-local-typing");
  });

  // The null path stays pinned: a shell with no local host sends no sender
  // host, rather than falling back to the target host.
  it("sends a null sentFromHostId when the directory has no local host", async () => {
    testState.getLocalHostId.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("inline please"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const message = sentInitialMessage(testState.createRequests[0]);
    expect(message.sentFromHostId ?? null).toBeNull();
  });

  // G-new-1: typing during the upload await is preserved - the create carries
  // the document as it stood when the upload settled, re-derived fresh via
  // re-entry rather than the stale capture.
  it("typing during the by-hash upload await is preserved: the create carries the NEW document", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("first"));

    act(() => {
      testState.bodySubmit?.();
    });
    await waitFor(() => {
      expect(testState.putBlobCalls).toHaveLength(1);
    });

    // The user edits the prompt while the upload is in flight, and the editor
    // boundary bumps the modal draft store's `revision` - what the generation
    // guard reads.
    const typed = byHashImageDoc("first and then more");
    act(() => {
      useNewConversationModalStore.getState().setContent(EPIC_ID, typed);
      testState.installEditor?.(typed);
    });

    // Release every call the retry issues, not just the first: a memo bug
    // (confirmed-hash filter deleted) makes the re-entry re-upload, which
    // parks a SECOND `drafts.putBlob` with nobody to answer it - draining the
    // queue here is what lets that ablation reach the assertions below
    // instead of dying on a length-0 create list first.
    await act(async () => {
      releaseOldestPutBlob(true);
      await flushMicrotasks();
    });
    while ((testState.putBlobResponse?.length ?? 0) > 0) {
      await act(async () => {
        releaseOldestPutBlob(true);
        await flushMicrotasks();
      });
    }

    expect(testState.createRequests).toHaveLength(1);
    const message = sentInitialMessage(testState.createRequests[0]);
    const text = JSON.stringify(message.content);
    expect(text).toContain("and then more");
    // Re-entered from scratch, and the re-derived plan finds the hash already
    // confirmed - it does not re-upload it.
    expect(testState.putBlobCalls).toHaveLength(1);
  });

  // G-new-2: a second submit while the upload is in flight is a no-op.
  it("a second submit during the by-hash upload await is a no-op", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashImageDoc("look"));

    act(() => {
      testState.bodySubmit?.();
    });
    await waitFor(() => {
      expect(testState.putBlobCalls).toHaveLength(1);
    });

    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createRequests).toHaveLength(0);

    await act(async () => {
      releaseOldestPutBlob(true);
      await flushMicrotasks();
    });

    expect(testState.createRequests).toHaveLength(1);
    // The second submit never started an upload of its own either.
    expect(testState.putBlobCalls).toHaveLength(1);
  });

  // Item 39: the host refuses more than 32 distinct hashes with an
  // `InvalidArgumentError` no surface renders, so this is checked on the
  // PLAN, before any upload, and toasted instead.
  it("refuses over the per-message hash cap with a toast, before uploading anything", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    renderModal(byHashManyImagesDoc(33));

    await submitAndSettle();
    // Drain every upload the cap check should have prevented from ever being
    // dispatched: with the cap enforced there is nothing pending here, so this
    // is a no-op on the real path - but it is what makes `createRequests`
    // below a genuine proof rather than a race that happens to read 0 because
    // the promise chain has not settled yet.
    while ((testState.putBlobResponse?.length ?? 0) > 0) {
      await act(async () => {
        releaseOldestPutBlob(true);
        await flushMicrotasks();
      });
    }

    expect(toast.error).toHaveBeenCalledWith("Too many images to attach.", {
      description:
        "A single message can carry at most 32 images. Remove some and try again.",
    });
    expect(testState.putBlobCalls).toHaveLength(0);
    expect(testState.createRequests).toHaveLength(0);
  });

  // Pin 2: the cap is checked on what the wire will actually carry, not on
  // the eligible-only set the pre-upload fast path sees. One eligible image
  // (this window holds bytes for) plus 32 hash-only nodes this window never
  // held bytes for clears the eligible-set check (1 <= 32) at :246 and must
  // be caught by the post-inlining check at :260, which counts all 33.
  it("refuses a mixed document at 33 wire hashes even though only 1 hash is eligible", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    imageStoreMocks.getImageBytes.mockImplementation((hash) =>
      Promise.resolve(hash === BY_HASH_SHA256 ? IMAGE_BYTES : undefined),
    );
    renderModal(mixedCapDoc());

    act(() => {
      testState.bodySubmit?.();
    });
    await waitFor(() => {
      expect(testState.putBlobCalls).toHaveLength(1);
    });
    // The pre-upload check saw only the eligible set (1 hash) and let this
    // through - the eligible node is the ONLY one that ever uploads.
    expect(testState.putBlobCalls[0]?.sha256).toBe(BY_HASH_SHA256);

    await act(async () => {
      releaseOldestPutBlob(true);
      await flushMicrotasks();
    });
    // Drain anything else still pending so a red here is never a race that
    // happens to read the right numbers before the promise chain settles.
    while ((testState.putBlobResponse?.length ?? 0) > 0) {
      await act(async () => {
        releaseOldestPutBlob(true);
        await flushMicrotasks();
      });
    }

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Too many images to attach.", {
      description:
        "A single message can carry at most 32 images. Remove some and try again.",
    });
    expect(testState.putBlobCalls).toHaveLength(1);
    expect(testState.createRequests).toHaveLength(0);
    // The modal did not close: the draft it started with is untouched and
    // `onSubmitted` never fired.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).not.toBeUndefined();
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });
});

// Pin 3: the destination is live through the upload await, and this pins
// that a mid-await move dispatches on the NEW host with content that host
// can actually resolve - never the old host's hashes.
/**
 * THE MECHANISM THIS PINS, because the assertions below are satisfiable by two
 * very different implementations and only one of them is correct.
 *
 * A confirmation is a fact about ONE machine's draft-blob tier: a digest host A
 * acknowledged is not held by host B. The submit's host-held set is therefore
 * read through `liveHostHeld()`, which compares the flight's captured host
 * against `submitTargetRef.current` and answers the EMPTY set once they differ -
 * the set is retracted on a switch rather than carried across.
 *
 * Retraction alone is what makes the create land correctly, and the reconcile
 * loop is why. `prepareDraftImageInlining` re-reads `readRequiredHashes()` after
 * every pass; a digest that stops being host-held comes back as REQUIRED, is
 * resolved on the next pass, and is inlined at commit. So the same switch that
 * invalidates the hashes is what causes their bytes to be fetched, with no
 * second submit and no refusal.
 *
 * The failure this exists to catch is silent: without the retraction, A's
 * confirmed digests stay subtracted from the required set, their bytes are
 * never resolved, `unresolved` comes back empty because they read as host-held,
 * and the create ships to B carrying bare hashes B never received. Every
 * assertion below except the last two would still pass.
 */
describe("new-conversation modal: destination race during the by-hash upload", () => {
  it("a destination switch mid-upload dispatches ONE create, on the NEW host, inline - never with the old host's hashes", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    // Host B has not negotiated the by-hash minor - the re-entry against it
    // must fall to the inline path, not carry A's hash-only node over.
    recordNegotiatedHostManifest(HOST_ID_B, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    imageStoreMocks.getImageBytes.mockResolvedValue(IMAGE_BYTES);
    const view = renderModal(byHashImageDoc("switch"));

    act(() => {
      testState.bodySubmit?.();
    });
    await waitFor(() => {
      expect(testState.putBlobCalls).toHaveLength(1);
    });
    expect(testState.putBlobCalls[0]).toEqual({
      sha256: BY_HASH_SHA256,
      hostId: HOST_ID,
    });

    // The destination moves to B while A's upload is still on the wire. The
    // picker is rendered live through the await, which is exactly this move.
    PLACEMENT_TARGET = makePlacementTarget(HOST_ID_B, "Other Host");
    act(() => {
      view.rerender(<Harness />);
    });

    await act(async () => {
      releaseOldestPutBlob(true);
      await flushMicrotasks();
    });
    // The retracted digest is picked back up by the reconcile loop's SECOND
    // pass, whose byte resolve is a further microtask hop - drain until the
    // create lands rather than asserting on a fixed number of flushes.
    await waitFor(() => {
      expect(testState.createRequests).toHaveLength(1);
    });

    // Exactly one create, on B - never a second one, and never on A.
    expect(testState.createRequests).toHaveLength(1);
    expect(testState.createRequests[0]?.hostId).toBe(HOST_ID_B);
    // No second body was ever put on the wire. B never negotiated the minor,
    // so nothing re-uploads there; the retraction routes the digest through
    // inlining instead, which needs no upload at all.
    expect(testState.putBlobCalls).toHaveLength(1);
    // The retraction actually reached the resolver. Without it the digest stays
    // host-held, is never required, and its bytes are never read - so this is
    // the assertion that separates a correct retraction from an absent one,
    // ahead of the shape checks below.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(BY_HASH_SHA256);

    const message = sentInitialMessage(testState.createRequests[0]);
    expect(message.attachmentsByHash ?? false).toBe(false);
    const atoms = collectImageAtoms(message.content);
    // Bytes, not a reference B never received. `rewriteHashOnlyImageNodes`
    // drops the `hash` attr as it writes `b64content`, so a node that inlined
    // carries exactly one of the two.
    expect(atoms[0]?.b64content).not.toBeNull();
    expect(atoms[0]?.hash ?? null).toBeNull();
  });
});

const WORKTREE_WORKSPACE_PATH = "/tmp/traycer-byhash";

function stageWorktreeIntent(): void {
  useNewConversationModalStore
    .getState()
    .addResolvedFolders(
      EPIC_ID,
      { folders: [], folderInfoByPath: {}, primaryPath: null },
      [
        {
          path: WORKTREE_WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: HOST_ID,
        },
      ],
    );
  useWorktreeIntentStagingStore
    .getState()
    .setIntent(newConversationModalStagingKey(HOST_ID, EPIC_ID, null), {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKTREE_WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat-defer-byhash",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
}

// Item 40 (G40): `deferWorktreeProvisioning` shares its negotiated minor
// (`@1.2`) with the by-hash gate, and the modal's own hold/seed bookkeeping -
// this suite already carries every OTHER fact the predicate needs
// (`hasInitialMessage`, a non-folderless workspace via `stageWorktreeIntent`
// above), so no third fixture file is needed for it.
describe("new-conversation modal: deferWorktreeProvisioning opt-in", () => {
  it("a worktree-intent create on a @1.2 host ships true and holds neither seed rows nor the binding listing", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    stageWorktreeIntent();
    renderModal(byHashImageDoc("defer please"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const request = testState.createRequests[0];
    expect(request.deferWorktreeProvisioning).toBe(true);
    const seed = readEpicCreateSeed(EPIC_ID, request.chatId);
    expect(seed).not.toBeNull();
    // The CONSEQUENCE, not the literal field: neither reader treats this
    // create as authoritative for the epic's binding listing or as holding it
    // against the create-path refetch.
    expect(isEpicCreateSeedPending(HOST_ID, EPIC_ID)).toBe(false);
    expect(isEpicCreateHeld(HOST_ID, EPIC_ID)).toBe(false);
  });

  it("the same worktree intent on a @1.1 host ships no key and marks nothing", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    stageWorktreeIntent();
    renderModal(byHashImageDoc("no defer"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const request = testState.createRequests[0];
    expect(request.deferWorktreeProvisioning).toBeUndefined();
    expect(readEpicCreateSeed(EPIC_ID, request.chatId)).toBeNull();
  });
});

/**
 * Ticket 8's modal unheld mark, pinned in the modal's own suite.
 *
 * The opt-in describe above pins the WIRE field and the entry's two
 * consumer-facing predicates. What it cannot see is the entry ITSELF: which
 * pair it is filed under, what its `release` closure actually invalidates, and
 * whether it exists by the time the create is dispatched. All three are
 * reachable only from a surface that owns the `queryClient` the closure
 * captured, which is why `QUERY_CLIENT` is hoisted above.
 *
 * The chatId is minted in the modal's own submit block (`uuidv4()`), not by the
 * host - the entry is keyed by the id this create CARRIES, and the assertion is
 * written against `request.chatId` for that reason rather than against any
 * value the response supplies.
 */
describe("new-conversation modal: the unheld seed mark", () => {
  const BINDINGS_KEY = hostQueryKeys.method<
    HostRpcRegistry,
    "worktree.listBindingsForEpic"
  >(HOST_ID, "worktree.listBindingsForEpic", { epicId: EPIC_ID });

  it("registers one unheld entry under the create's own chatId, and its release invalidates that epic's binding listing on that host", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    stageWorktreeIntent();
    renderModal(byHashImageDoc("defer and release"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const request = testState.createRequests[0];
    const seed = readEpicCreateSeed(EPIC_ID, request.chatId);
    expect(seed).not.toBeNull();
    // The entry's facts spelled out, not read back through the two predicates
    // the opt-in describe uses: those answer `false` for an ABSENT entry too,
    // so on their own they cannot tell "registered unheld" from "not
    // registered at all".
    expect(seed?.hostId).toBe(HOST_ID);
    expect(seed?.seedRows).toBe(false);
    expect(seed?.heldForDeferredCreate).toBe(false);
    expect(seed?.seededMessageId).not.toBeNull();
    // Filed under the chat this create is FOR. `null` is the terminal-agent
    // landing slot - the one other key this epic's map can hold, and one the
    // modal must never file under.
    expect(readEpicCreateSeed(EPIC_ID, null)).toBeNull();

    // A closure that invalidates SOMETHING is half the claim; the key is the
    // other half. Exact-object equality rather than a `queryKey` field read, so
    // a widened call (an added `refetchType`, a dropped predicate) is a red
    // here and not a silent scope change.
    const invalidate = vi.spyOn(QUERY_CLIENT, "invalidateQueries");
    releaseEpicCreateSeed(EPIC_ID, request.chatId);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: BINDINGS_KEY });
    expect(readEpicCreateSeed(EPIC_ID, request.chatId)).toBeNull();
  });

  // The opt-in describe's negative turns on the NEGOTIATED MINOR. This one
  // turns on a different fact of the four (no `kind: "worktree"` intent, and
  // hence a folderless mode), so a mark hoisted above `shouldDefer...` - which
  // a version-only negative still accepts on a @1.1 host - reddens here.
  it("a create with no staged worktree intent on the same @1.2 host ships no key and marks nothing", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    renderModal(byHashImageDoc("no intent"));

    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    const request = testState.createRequests[0];
    expect(request.deferWorktreeProvisioning).toBeUndefined();
    expect(readEpicCreateSeed(EPIC_ID, request.chatId)).toBeNull();
  });

  it("registers the entry BEFORE the create is dispatched", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    stageWorktreeIntent();
    // Sampled INSIDE the dispatch. The entry is still registered when the
    // submit block returns either way, so a read taken after `submitAndSettle`
    // cannot tell a mark that PRECEDED `mutateAsync` from one that followed it
    // - which is the whole ordering claim, since the handoff opens a tab
    // eagerly off this same block and the driver reads the entry.
    //
    // A holder rather than a bare `let`: TS's flow analysis narrows a `let`
    // assigned only inside a callback to `null` at the assertion below.
    const dispatch: { seed: EpicCreateSeedEntry | null } = { seed: null };
    testState.createChat.mockImplementation((request) => {
      dispatch.seed = readEpicCreateSeed(EPIC_ID, request.chatId);
      return Promise.resolve({ initialTurnStarted: false });
    });
    renderModal(byHashImageDoc("ordered"));

    await submitAndSettle();

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(dispatch.seed).not.toBeNull();
    expect(dispatch.seed?.heldForDeferredCreate).toBe(false);
  });
});
