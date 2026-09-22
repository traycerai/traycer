import { createRef, useRef, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

/**
 * The slice of the `epic.createChat` request the generation-guard case below
 * reads back. Named so `mock.calls[0][0]` has a type at all - an implementation
 * inferred from a zero-argument stub gives the mock an EMPTY argument tuple, and
 * indexing it is the compile error rather than the `undefined` it looks like.
 *
 * `initialMessage` is `.nullable().optional()` on the wire and is spelled that
 * way here, so the read site has to narrow rather than assume.
 */
interface GateCreateChatRequest {
  readonly initialMessage?: { readonly content: JsonContent } | null;
}

const testState = vi.hoisted(() => ({
  createChat: vi.fn<
    (request: GateCreateChatRequest) => Promise<{
      readonly initialTurnStarted: boolean;
    }>
  >(() => Promise.resolve({ initialTurnStarted: false })),
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
  // What the installed editor currently holds. `null` keeps every pre-existing
  // test on `DIRTY_CONTENT`; the generation-guard tests below swap it MID-AWAIT,
  // which is the one thing a fixed-content stub cannot express.
  editorDoc: null as JsonContent | null,
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
  useEpicTitle: () => "Epic",
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

// Recording the call, not just retargeting the mock's module path, is
// deliberate: a mock that intercepts nothing looks identical to one that
// works (this is exactly how the stale mock survived the modal's move to the
// hash-only paste adapter unnoticed). Asserting the stub actually ran is what
// fails loudly the next time this hook is renamed or re-homed, instead of
// silently handing the test the real hook again.
const useComposerHashPasteCalls = vi.fn();

vi.mock("@/hooks/composer/use-composer-paste", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/composer/use-composer-paste")
  >("@/hooks/composer/use-composer-paste");
  // A function, not a hoisted object literal: it must re-read `testState`
  // fresh on every call, since each test toggles `ingesting`/`resolvingPaths`
  // AFTER the module (and this factory) already evaluated.
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
    isIngestingImages: testState.ingesting,
    isResolvingFilePaths: testState.resolvingPaths,
  });
  return {
    ...actual,
    useComposerPaste: stubPasteResult,
    // The modal actually calls this one (the hash-only paste adapter), not
    // `useComposerPaste` above - the real hook running underneath left
    // `testState.ingesting`/`resolvingPaths` toggling nothing.
    useComposerHashPaste: (
      ...args: Parameters<typeof actual.useComposerHashPaste>
    ) => {
      useComposerHashPasteCalls(...args);
      return stubPasteResult();
    },
  };
});

// The modal's hash-first submit reads bytes back through these two. Held open
// below so the test can act DURING the read, which is where the whole
// stale-capture failure lives.
const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
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
  testState.editorDoc = null;
  useAuthStore.setState({ profile: null });
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockReset();
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
              placement={null}
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
    const { rerender } = render(<Med4Harness focused />, {
      wrapper: QueryWrapper,
    });
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

/**
 * `NewConversationModalBody` reads a `QueryClient` (the deferred create's
 * binding-seed release closure), and in the app it always renders under the
 * app-wide provider. One client per render so nothing leaks between cases.
 */
function QueryWrapper({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createAppQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NewConversationModalBody direct submit gate", () => {
  it("submits a new chat with Cmd+Enter from anywhere in the modal", () => {
    render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={null}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
      { wrapper: QueryWrapper },
    );

    // The modal must actually be wired to the hash-first paste hook, not
    // silently running the real one because a stale mock stopped
    // intercepting anything (see the mock's own comment above).
    expect(useComposerHashPasteCalls).toHaveBeenCalled();

    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
  });

  it("treats every hash as present before snapshot readiness, then defers to the real predicate", () => {
    // The modal's `hasPastedImageBytes` is now the union of this window's
    // composer image store (always available, hash-first) and the epic's
    // attachment-presence snapshot. Before that snapshot is ready it treats
    // every hash as present rather than withholding a predicate entirely -
    // there is no longer a "no predicate" state.
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={null}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
      { wrapper: QueryWrapper },
    );

    expect(testState.bodyAttachmentPresence?.("anything")).toBe(true);

    testState.attachmentPresence = (hash) => hash === "present-hash";
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={null}
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
        placement={null}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
      { wrapper: QueryWrapper },
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
        placement={null}
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
        placement={null}
        parentId={null}
        hostId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
      { wrapper: QueryWrapper },
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
        placement={null}
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

const MODAL_HASH = "hash-modal-image-1";
const MODAL_BYTES = new Uint8Array([9, 8, 7, 6]);

function hashOnlyDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "modal-node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash: MODAL_HASH,
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

function docText(content: JsonContent): string {
  const parts: string[] = [];
  const walk = (node: JsonContent): void => {
    if (typeof node.text === "string") parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(content);
  return parts.join("");
}

// Both of these are about the window between pressing send and the create going
// out. The modal's editor is NOT disabled across the image read, and the create
// ends in `cleanupAfterSubmit` - which clears the draft store AND the editor. So
// a submit that dispatches the document it captured and then clears the current
// one destroys whatever was typed during the read, with no way back.
describe("NewConversationModalBody submit generation guard", () => {
  beforeEach(() => {
    useAuthStore.setState({
      profile: {
        userId: "user-1",
        userName: "Tester",
        email: "t@example.com",
      },
    });
    testState.editorDoc = hashOnlyDoc("first");
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  });

  it("typing during the await is preserved: the create carries the NEW document", async () => {
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open; the re-resolution of the edited
      // document resolves at once.
      if (releaseRead !== null) return Promise.resolve(MODAL_BYTES);
      return new Promise<Uint8Array | undefined>((resolve) => {
        releaseRead = resolve;
      });
    });

    render(<Med4Harness focused />, { wrapper: QueryWrapper });
    act(() => {
      testState.installEditor?.();
    });
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).not.toHaveBeenCalled();

    // A real keystroke: the document changes and the editor boundary records
    // the mutation, which is what bumps the draft `revision` the generation is
    // read from.
    const typed = hashOnlyDoc("first and then more");
    act(() => {
      testState.editorDoc = typed;
      useNewConversationModalStore.getState().setContent("epic-1", typed);
    });

    await act(async () => {
      releaseRead?.(MODAL_BYTES);
      await flushMicrotasks();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    const sent = testState.createChat.mock.calls[0][0].initialMessage;
    // Narrowed rather than asserted-and-then-indexed: `expect().not.toBeNull()`
    // does not narrow for the compiler, and a named sentence beats the
    // TypeError three lines down if the modal ever ships a message-less create.
    if (sent === null || sent === undefined) {
      throw new Error("the modal dispatched a create with no initial message");
    }
    // The create carries the text typed DURING the read. With the captured
    // document this reads "first".
    expect(docText(sent.content)).toContain("and then more");
    // It was re-resolved from scratch rather than sent stale and patched up.
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(2);
    const atoms = collectImageAtoms(sent.content);
    expect(atoms[0]?.b64content).toBe(
      btoa(String.fromCharCode(...MODAL_BYTES)),
    );
  });

  it("a second submit during the await is a no-op, including via the synchronous path", async () => {
    let releaseRead: ((bytes: Uint8Array) => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(
      () =>
        new Promise<Uint8Array | undefined>((resolve) => {
          releaseRead = resolve;
        }),
    );

    render(<Med4Harness focused />, { wrapper: QueryWrapper });
    act(() => {
      testState.installEditor?.();
    });
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);

    // Session-warm by the time the user clicks again, so this second submit
    // would take the SYNCHRONOUS path - the one the per-arm guard never
    // covered, and the one that creates a second chat for one prompt.
    imageStoreMocks.sessionImageBytes.mockReturnValue(MODAL_BYTES);
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).not.toHaveBeenCalled();

    await act(async () => {
      releaseRead?.(MODAL_BYTES);
      await flushMicrotasks();
    });
    expect(testState.createChat).toHaveBeenCalledTimes(1);
    // Drain again: a second create would land here.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await Promise.resolve();
  }
}

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => testState.editorDoc ?? DIRTY_CONTENT,
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
