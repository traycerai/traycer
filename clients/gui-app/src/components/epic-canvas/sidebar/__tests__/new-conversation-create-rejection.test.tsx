import { useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import {
  selectInitialChatHandoff,
  useInitialChatHandoffStore,
  type InitialChatHandoff,
} from "@/stores/epics/initial-chat-handoff-store";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useAuthStore } from "@/stores/auth/auth-store";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

/**
 * The in-Epic new-agent modal's CREATE-REJECTED path.
 *
 * Staging finding, 2026-08-19: a "New worktree" whose branch name already
 * existed made the host hard-fail `epic.createChat` (409, the `git worktree
 * add` reason on the message). The eager-opened "Untitled agent" tab then sat
 * there - "Loading this agent from <host>…", then, once the 15s tile budget
 * elapsed, "That host hasn't answered." The host HAD answered; it refused.
 *
 * The mechanism that takes such a tab down already existed - a `failed` handoff
 * is terminal, which releases `pendingCreateArtifactIds` and lets the record
 * sweep close the tile - but the modal marked the failure from `mutate`'s
 * per-call `onError`, and TanStack Query v5 drops those once the observer has
 * no listeners. This modal closes itself SYNCHRONOUSLY on submit, so that
 * callback could never run: the handoff stayed non-terminal until the 60s
 * orphan deadline, which is a backstop written for a host that says nothing.
 *
 * So the assertions here are about the handoff reaching `failed` DESPITE the
 * unmount. The harness reproduces the unmount exactly as the real dialog does
 * it (`props.open ? <Body/> : null`), because a harness that keeps the body
 * mounted passes either way and proves nothing.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const EPIC_ID = "epic-1";
const HOST_ID = "host-a";
/**
 * Signed in for every case here, deliberately. `userId` is half the handoff
 * key, and it is also what decides whether the request carries an
 * `initialMessage` at all - which is the only way a host can answer
 * `initialTurnStarted: true`. A signed-out harness would let the success case
 * assert a response the system cannot actually produce.
 */
const USER_ID = "user-1";

/** What the host answers when `git worktree add` refused the branch name. */
function worktreeCreateRejection(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message:
      "git worktree add failed for traycer/tidy-badger: " +
      "fatal: a branch named 'traycer/tidy-badger' already exists",
    requestId: "req-1",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

const testState = vi.hoisted(() => ({
  /** Resolved per test - a rejection, or a deferred one for the race case. */
  createChat:
    vi.fn<(request: { readonly chatId: string }) => Promise<unknown>>(),
  /** Every request the modal sent, so a test can name the chat it submitted. */
  createRequests: [] as Array<{ readonly chatId: string }>,
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      return React.createElement("div", null, props.topBanner);
    },
  };
});

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
    dismissActiveSuggestion: () => false,
  };
}

const PLACEMENT_TARGET = {
  resolvedHostId: HOST_ID,
  client: { getActiveHostId: () => HOST_ID },
  hostLabel: "Studio Mac",
  isPinned: false,
  namedHostDead: false,
};

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
    mutateAsync: (request: { readonly chatId: string }) => {
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

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
}));

const stubHostClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
vi.mock("@/lib/host", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/lib/host/runtime", () => ({ useHostClient: () => stubHostClient }));

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
vi.mock("@/hooks/composer/use-composer-paste", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/composer/use-composer-paste")
  >("@/hooks/composer/use-composer-paste");
  return {
    ...actual,
    useComposerPaste: () => ({
      onPaste: vi.fn(),
      onDrop: vi.fn(),
      onDragOver: vi.fn(),
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      attachImageFiles: vi.fn(),
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

/**
 * The real dialog renders its body behind `props.open`, so submitting UNMOUNTS
 * the component that owns the create mutation. That is the whole point of this
 * suite, so the harness reproduces it rather than keeping the body alive.
 */
function Harness() {
  const [open, setOpen] = useState(true);
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  return (
    <SurfacePresentationBoundary visible focused>
      <Dialog open>
        <DialogContent>
          {open ? (
            <NewConversationTransientContext.Provider value={transient}>
              <NewConversationModalBody
                epicId={EPIC_ID}
                tabId="tab-1"
                placement={ACTIVE_TILE_PLACEMENT}
                parentId={null}
                hostId={null}
                dismissPickerRef={dismissPickerRef}
                onSubmitted={() => setOpen(false)}
              />
            </NewConversationTransientContext.Provider>
          ) : null}
        </DialogContent>
      </Dialog>
    </SurfacePresentationBoundary>
  );
}

/**
 * The handoff for this epic, read by SCOPE - the modal mints its own chat id,
 * so the test cannot name it up front. `initialChatHandoffKey` is
 * {user, epic}, and the host segment is data on the record rather than part of
 * the key.
 */
function handoff(): InitialChatHandoff | null {
  return selectInitialChatHandoff(useInitialChatHandoffStore.getState(), {
    hostId: HOST_ID,
    userId: USER_ID,
    epicId: EPIC_ID,
  });
}

function renderModal(): void {
  render(<Harness />);
  act(() => {
    testState.installEditor?.();
  });
}

/**
 * Submit, then drain the microtasks the create's promise chain settles on.
 * `.then` and `.catch` are separate links, so an already-rejected `mutateAsync`
 * still needs more than one turn to reach the failure arm.
 */
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

beforeEach(() => {
  useAuthStore.setState({
    profile: { userId: USER_ID, userName: "Tester", email: "t@example.com" },
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode(EPIC_ID, "chat");
  useInitialChatHandoffStore.getState().resetForTests();
  testState.createRequests.length = 0;
  testState.createChat.mockReset();
  testState.createChat.mockRejectedValue(worktreeCreateRejection());
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null });
  testState.bodySubmit = null;
  testState.installEditor = null;
  useNewConversationModalStore.getState().resetForTests();
  useInitialChatHandoffStore.getState().resetForTests();
});

describe("new-conversation modal: a rejected create leaves no live pending tab", () => {
  it("registers a live handoff at submit - the eager tab's licence to exist", async () => {
    renderModal();
    // Pinned so the failure assertion below cannot pass vacuously: if nothing
    // were ever registered, "not pending" would be true for the wrong reason.
    testState.createChat.mockReturnValue(new Promise(() => undefined));
    await submitAndSettle();

    expect(handoff()?.status).toBe("pending");
  });

  it("marks the handoff failed when the host rejects the create, after the modal has closed", async () => {
    renderModal();
    await submitAndSettle();

    // The modal is gone - the create's own observer has no listeners left.
    expect(testState.createRequests).toHaveLength(1);
    const settled = handoff();
    expect(settled?.status).toBe("failed");
    expect(settled?.failureReason).toBe("Couldn't create the agent.");
  });

  // Review #1297 finding 3, the symmetric case. `markInitialTurnStarted` was
  // dead for the SAME observer-unmount reason as the failure arm: the host has
  // already kicked the provider turn from `initialMessage`, and this is what
  // tells the handoff driver not to send it again. A regression leaves the
  // handoff short of `sending` and costs a redundant round trip.
  it("marks the initial turn started when the create resolves after the modal has closed", async () => {
    testState.createChat.mockResolvedValue({ initialTurnStarted: true });
    renderModal();
    await submitAndSettle();

    expect(testState.createRequests).toHaveLength(1);
    expect(handoff()?.status).toBe("sending");
  });

  // The other side of that arm: the host did NOT start the turn, so the driver
  // still owes the send and the handoff must not jump ahead of it.
  it("leaves the handoff pending when the host did not start the initial turn", async () => {
    testState.createChat.mockResolvedValue({ initialTurnStarted: false });
    renderModal();
    await submitAndSettle();

    expect(handoff()?.status).toBe("pending");
  });

  it("fails only the handoff that was actually rejected, never a later create's", async () => {
    // The handoff key is {user, epic}, so a second create in this epic REPLACES
    // the entry. Now that the rejection arm actually runs, an unguarded
    // `markFailed` would close the second agent's tab when the first one's
    // rejection landed - which is why the modal uses `markFailedByAction`.
    let rejectFirst: (error: HostRpcError) => void = () => undefined;
    testState.createChat.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    testState.createChat.mockReturnValue(new Promise(() => undefined));

    renderModal();
    await submitAndSettle();
    const first = handoff();

    // A second submit, still in flight, replaces the scope's handoff.
    cleanup();
    useNewConversationModalStore.getState().setContent(EPIC_ID, DIRTY_CONTENT);
    renderModal();
    await submitAndSettle();
    const second = handoff();
    expect(second?.chatId).not.toBe(first?.chatId);

    await act(async () => {
      rejectFirst(worktreeCreateRejection());
      await flushMicrotasks();
    });

    expect(handoff()?.chatId).toBe(second?.chatId);
    expect(handoff()?.status).toBe("pending");
  });
});
