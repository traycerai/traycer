import { createRef, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const testState = vi.hoisted(() => ({
  createChat: vi.fn(() => Promise.resolve({ initialTurnStarted: false })),
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  ingesting: false,
  resolvingPaths: false,
  attachmentPresence: null as ((hash: string) => boolean) | null,
  bodyAttachmentPresence: null as ((hash: string) => boolean) | null,
  bodyPickerStore: null as ComposerPickerStore | null,
  bodyInitialSelection: null as { from: number; to: number } | null,
  bodySnapshot: null as
    | ((content: JsonContent, selection: { from: number; to: number }) => void)
    | null,
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyAttachmentPresence = props.hasPastedImageBytes;
      testState.bodyPickerStore = props.pickerStore;
      testState.bodyInitialSelection = props.initialSelection;
      testState.bodySnapshot = props.onDocumentChange;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      return React.createElement(
        "button",
        { type: "button", onClick: props.onSubmit },
        "Submit new conversation",
      );
    },
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  return { useComposerToolbarStore: () => toolbarStore };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicAgentRoleClaims: () => [],
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
}));

const stubHostClient = {
  getActiveHostId: () => "host-1",
  // Read by `useHostClientFor` on every render, ahead of its own null gate.
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => stubHostClient,
  // The modal's per-host memory key for the unpinned path subscribes through
  // the binding; null = no active host, so memory reads fall to the legacy tier
  // and writes no-op - inert here.
  //
  // This comment used to name `useAddressableHostId` as the subscriber. That
  // hook no longer exists anywhere in the tree; the sentence is left describing
  // the binding it actually mocks rather than being re-pointed at a successor
  // nobody has verified. What is asserted here is the `null`, not the reader.
  useHostBinding: () => null,
}));
vi.mock("@/lib/host/runtime", () => ({ useHostClient: () => stubHostClient }));

// P1.2: the body resolves its placement through this hook and refuses to
// create when it is unusable. This suite is about the SUBMIT GATE, not
// placement, so it presents a usable one addressing the stub client's host.
vi.mock("@/hooks/host/use-composer-placement", () => {
  // Built inside the factory: `vi.mock` is hoisted above the module-level
  // `stubHostClient`, so closing over it would read a TDZ binding.
  const target = {
    resolvedHostId: "host-1",
    client: { getActiveHostId: () => "host-1" },
    hostLabel: "Local",
    isPinned: false,
    namedHostDead: false,
  };
  return {
    // The modal resolves the per-EPIC placement (not the landing composer's
    // `useComposerPlacement`); same shape, plus `followsEffective`.
    useEpicConversationPlacement: () => ({
      pin: {
        selection: null,
        honoredSelection: null,
        setSelection: () => undefined,
        resolvedHostId: "host-1",
        isPinned: false,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => "Local",
      followsEffective: true,
    }),
  };
});

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-1",
}));

// The body resolves its host through `useHostClientForHostId`, which reads the
// directory to pin an explicit id. This suite only exercises the unpinned
// (`hostId: null`) path, where that lookup is skipped and the app-wide client
// above is returned as-is - so an empty directory is all it needs.
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
      isIngestingImages: testState.ingesting,
      isResolvingFilePaths: testState.resolvingPaths,
    }),
  };
});

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => true,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    // `mutateAsync`, matching the modal - see `new-conversation-placement`.
    mutateAsync: testState.createChat,
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({ isPending: false, create: vi.fn() }),
}));

vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  // Same treatment as `use-composer-dictation` above: a host-backed readiness
  // hook stubbed to its "nothing to report" answer so these gate tests stay
  // about the gate they name. `blocked: false` is also the hook's real
  // fail-open answer before `providers.list` resolves.
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
  useEpicAttachmentBytesPresence: () => testState.attachmentPresence,
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

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
});

afterEach(() => {
  cleanup();
  testState.createChat.mockClear();
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.ingesting = false;
  testState.resolvingPaths = false;
  testState.attachmentPresence = null;
  testState.bodyAttachmentPresence = null;
  testState.bodyPickerStore = null;
  testState.bodyInitialSelection = null;
  testState.bodySnapshot = null;
  useNewConversationModalStore.getState().resetForTests();
});

function Med4Harness(props: { readonly focused: boolean }) {
  // Mimics `NewConversationModalDialog`: the picker store lives ABOVE the
  // `DialogContent` gate, so it survives the body's focus-driven unmount. The
  // caret is persisted in the draft store, which also outlives the unmount.
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  return (
    <SurfacePresentationBoundary visible focused={props.focused}>
      <Dialog open>
        <DialogContent>
          <NewConversationTransientContext.Provider value={transient}>
            <NewConversationModalBody
              epicId="epic-1"
              tabId="tab-1"
              placement={ACTIVE_TILE_PLACEMENT}
              parentId={null}
              hostId={null}
              dismissPickerRef={dismissPickerRef}
              onSubmitted={() => undefined}
            />
          </NewConversationTransientContext.Provider>
        </DialogContent>
      </Dialog>
    </SurfacePresentationBoundary>
  );
}

describe("NewConversationModalBody focus round-trip (MED4)", () => {
  it("preserves the composer picker store and editor selection when the pane loses and regains focus", () => {
    const { rerender } = render(<Med4Harness focused />);
    const pickerBefore = testState.bodyPickerStore;
    expect(pickerBefore).not.toBeNull();

    // The editor reports a caret; the body records it on its lifted holder.
    act(() => {
      testState.bodySnapshot?.(DIRTY_CONTENT, { from: 3, to: 5 });
    });

    // Focus away: DialogContent unmounts the whole body subtree.
    act(() => {
      rerender(<Med4Harness focused={false} />);
    });
    expect(
      screen.queryByRole("button", { name: "Submit new conversation" }),
    ).toBeNull();

    // Focus back: the body remounts and reads the SAME lifted state, not a
    // fresh picker store or a reset (null) selection.
    act(() => {
      rerender(<Med4Harness focused />);
    });
    expect(testState.bodyPickerStore).toBe(pickerBefore);
    expect(testState.bodyInitialSelection).toEqual({ from: 3, to: 5 });
  });
});

describe("NewConversationModalBody direct submit gate", () => {
  it("submits a new chat with Cmd+Enter from anywhere in the modal", () => {
    render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
  });

  it("passes no paste predicate before snapshot readiness and the predicate afterward", () => {
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );

    expect(testState.bodyAttachmentPresence).toBeNull();

    testState.attachmentPresence = (hash) => hash === "present-hash";
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );

    expect(testState.bodyAttachmentPresence?.("present-hash")).toBe(true);
    expect(testState.bodyAttachmentPresence?.("missing-hash")).toBe(false);
  });

  it("blocks the actual new-conversation submit path while image ingestion is pending", () => {
    testState.ingesting = true;
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).not.toHaveBeenCalled();

    testState.ingesting = false;
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).toHaveBeenCalledTimes(1);
  });

  // Finding 3: pure path-resolution must also hold submit open.
  it("blocks the actual new-conversation submit path while file-path resolution is pending", () => {
    testState.resolvingPaths = true;
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).not.toHaveBeenCalled();

    testState.resolvingPaths = false;
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).toHaveBeenCalledTimes(1);
  });
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
