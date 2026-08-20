import { isValidElement, useRef, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  newConversationModalStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { notifyEffectiveHostChanged } from "@/stores/host/surface-host-selection-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

/**
 * F2: the in-Epic new-conversation modal shares the landing composer's
 * placement SEMANTICS (one chip, one frozen submit client, one refusal),
 * resolved for its EPIC (`useEpicConversationPlacement`: per-Epic pin - the
 * Epic's last created chat's host - ?? the session's host ?? effective).
 *
 * These target the CALLER, not `resolveLandingPlacement` (already unit-tested):
 * the class of bug here is a caller that never asks, which no test of the
 * resolver can catch. The ordering assertions are the load-bearing ones —
 * `cleanupAfterSubmit` clears the draft, the staged workspace and the modal
 * SYNCHRONOUSLY, long before an async create could report failure, so a
 * refusal that arrives after it has run has already destroyed the user's work.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const STAGING_KEY = newConversationModalStagingKey("host-a", "epic-1", null);
const STAGING_KEY_ID = worktreeStagingKeyString(STAGING_KEY);

/** A per-machine choice: exactly the state G4 must not carry across hosts. */
const STAGED_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};

function stagedIntent(): WorktreeIntent | undefined {
  return useWorktreeIntentStagingStore.getState().intentByKey[STAGING_KEY_ID];
}

interface PlacementTargetShape {
  readonly resolvedHostId: string | null;
  readonly client: { readonly getActiveHostId: () => string | null } | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  readonly namedHostDead: boolean;
}

/**
 * Annotated rather than asserted: the holder must be WIDE enough for a test to
 * present a null client or a different host, which an inferred literal type
 * would refuse.
 */
function placementHolder(): { current: PlacementTargetShape } {
  return {
    current: {
      resolvedHostId: "host-a",
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    },
  };
}

const testState = vi.hoisted(() => ({
  createChat: vi.fn<
    (request: { readonly hostId: string }) => Promise<{
      readonly initialTurnStarted: boolean;
    }>
  >(() => Promise.resolve({ initialTurnStarted: false })),
  createTerminalAgent: vi.fn(() => Promise.resolve(null)),
  onSubmitted: vi.fn(),
  bodySubmit: null as (() => void) | null,
  bodyStartTerminal: null as ((launch: TerminalAgentLaunch) => void) | null,
  installEditor: null as (() => void) | null,
  /** Drives what the modal's placement resolves to, per test. */
  placement: placementHolder(),
  pinIsPinned: { current: false },
  /**
   * Whether `effective` answered the placement (no override, no pin in force,
   * no session-host default in force) - the ONLY state a derivation move
   * re-points (G4). Independent of `pinIsPinned` on purpose: a modal resting
   * on the Epic's host is unpinned AND not following.
   */
  followsEffective: { current: true },
  /** The Epic's placement memory write - what a create RECORDS. */
  recordPlacement: vi.fn<(hostId: string | null) => void>(),
  /** What `useEpicConversationPlacement` was asked to resolve. */
  placementInputs: [] as Array<{
    readonly epicId: string;
    readonly overrideHostId: string | null;
    readonly sessionHostId: string | null;
  }>,
  /**
   * The workspace-controls element the body was handed (Codex T-50). The
   * ComposerBody mock renders only the banner, so the picker's `hostScope`
   * is read off the element's props rather than through a render.
   */
  workspaceControlsElements: [] as unknown[],
  /** The pin the latest-conversation seed was read for (Codex T-50). */
  latestSeedPins: [] as unknown[],
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyStartTerminal = props.onStartTerminal;
      testState.workspaceControlsElements.push(props.workspaceControls);
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

// THE seam under test's input. Mocked so each case can present a specific
// placement (dead pin, moved client) without standing up a real fleet. The
// modal resolves the per-EPIC placement, not the landing composer's
// window-keyed one - a mock of `useComposerPlacement` here would be stranded.
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: (input: {
    readonly epicId: string;
    readonly overrideHostId: string | null;
    readonly sessionHostId: string | null;
  }) => {
    testState.placementInputs.push(input);
    return {
      pin: {
        selection: null,
        honoredSelection: null,
        setSelection: testState.recordPlacement,
        resolvedHostId: testState.placement.current.resolvedHostId,
        isPinned: testState.pinIsPinned.current,
        latchOnFirstUse: () => undefined,
      },
      target: testState.placement.current,
      submitTarget: testState.placement.current,
      hostLabelFor: () => testState.placement.current.hostLabel,
      followsEffective: testState.followsEffective.current,
    };
  },
}));

// The Epic session's host, the modal's DEFAULT placement tier - handed to the
// (mocked) placement above, so this suite pins that the modal asks for the
// session's host and not the app-wide one.
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-session",
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    // `mutateAsync`, matching the modal: it closes itself on submit, so its
    // completion handling rides a promise chain rather than the per-call
    // callbacks TanStack drops with the observer.
    mutateAsync: testState.createChat,
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    isPending: false,
    create: testState.createTerminalAgent,
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
  getActiveHostId: () => "host-a",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
vi.mock("@/lib/host", () => ({ useHostClient: () => stubHostClient }));
vi.mock("@/lib/host/runtime", () => ({ useHostClient: () => stubHostClient }));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: (_epicId: unknown, pin: unknown) => {
    testState.latestSeedPins.push(pin);
    return null;
  },
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
vi.mock("@/stores/epics/initial-chat-handoff-store", () => ({
  useInitialChatHandoffStore: {
    getState: () => ({
      register: vi.fn(),
      markInitialTurnStarted: vi.fn(),
      markFailedByAction: vi.fn(),
    }),
  },
}));

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
              epicId="epic-1"
              tabId="tab-1"
              placement={ACTIVE_TILE_PLACEMENT}
              parentId={null}
              hostId={null}
              dismissPickerRef={dismissPickerRef}
              onSubmitted={testState.onSubmitted}
            />
          </NewConversationTransientContext.Provider>
        </DialogContent>
      </Dialog>
    </SurfacePresentationBoundary>
  );
}

/**
 * The `hostScope` prop of the `<ActiveHostWorkspaceControls>` element the
 * body was handed. `null` when the element is not that component (the arm
 * then fails on the shape assertion rather than on a thrown read).
 */
function workspaceControlsHostScope(element: unknown): unknown {
  if (!isValidElement<{ readonly hostScope: unknown }>(element)) return null;
  return element.props.hostScope;
}

function renderModal(): void {
  render(<Harness />);
  act(() => {
    testState.installEditor?.();
  });
}

function noticeText(): string {
  return screen.getByTestId("composer-host-notice").textContent;
}

function draftSurvived(): boolean {
  const patch =
    useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
  return patch?.content !== undefined && patch.content !== null;
}

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
  useWorktreeIntentStagingStore.getState().clear(STAGING_KEY);
  testState.placement.current = {
    resolvedHostId: "host-a",
    client: { getActiveHostId: () => "host-a" },
    hostLabel: "Studio Mac",
    isPinned: false,
    namedHostDead: false,
  };
  testState.pinIsPinned.current = false;
  testState.followsEffective.current = true;
  testState.workspaceControlsElements = [];
  testState.latestSeedPins = [];
  testState.recordPlacement.mockClear();
  testState.placementInputs.length = 0;
});

afterEach(() => {
  cleanup();
  testState.createChat.mockClear();
  testState.createChat.mockResolvedValue({ initialTurnStarted: false });
  testState.createTerminalAgent.mockClear();
  testState.onSubmitted.mockClear();
  testState.bodySubmit = null;
  testState.bodyStartTerminal = null;
  useNewConversationModalStore.getState().resetForTests();
});

describe("new-conversation modal shares the composer's placement semantics", () => {
  it("creates on the resolved host when the placement is usable", () => {
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-a" }),
    );
  });

  // A pin never sets `namedHostDead` (D6): by the time `useComposerPlacement`
  // resolves, a pinned host that died has already auto-followed to the
  // effective host - `resolvedHostId` names the LIVE host, and the create
  // must land there instead of being refused.
  it("creates on the effective host once a pinned host has auto-followed through death", () => {
    testState.pinIsPinned.current = true;
    testState.placement.current = {
      resolvedHostId: "host-effective",
      client: { getActiveHostId: () => "host-effective" },
      hostLabel: "Home Mac",
      isPinned: true,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-effective" }),
    );
  });

  // The ordering finding: a refusal that lands after `cleanupAfterSubmit` has
  // already run has destroyed the draft, the staged workspace and the modal.
  it("leaves the draft, the staged intent and the modal intact on refusal", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    testState.placement.current = {
      resolvedHostId: "host-b",
      client: null,
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(stagedIntent()).toBeDefined();
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("refuses when the client no longer addresses the rendered host", () => {
    testState.placement.current = {
      resolvedHostId: "host-b",
      // The chip renders host-b; this client would send to host-a.
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(noticeText()).toContain("Build Box");
  });

  it("refuses the TERMINAL path on the same verdict, creating nothing", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    testState.placement.current = {
      resolvedHostId: "host-b",
      client: null,
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodyStartTerminal?.({
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        terminalAgentArgs: null,
        profileId: null,
      });
    });

    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("G4: a FOLLOWING modal clears its staged intent and says so when effective moves", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeUndefined();
    expect(noticeText()).toContain("now run on");
  });

  it("G4: a PINNED modal keeps its staged intent (D6)", () => {
    testState.pinIsPinned.current = true;
    testState.followsEffective.current = false;
    testState.placement.current = {
      ...testState.placement.current,
      isPinned: true,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeDefined();
  });

  it("G4: a modal resting on the EPIC's host (default tier, unpinned) keeps its staged intent", () => {
    // The third state the per-Epic placement introduced: no pin, but the
    // session's host answered rather than `effective`. A gate keyed on
    // `isPinned` alone would clear this modal's staged intent and announce a
    // move that did not happen to it.
    testState.pinIsPinned.current = false;
    testState.followsEffective.current = false;
    testState.placement.current = {
      resolvedHostId: "host-session",
      client: { getActiveHostId: () => "host-session" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeDefined();
    // And no move narrated: there is no notice at all.
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("asks the per-EPIC placement for THIS epic with the session's host as its default", () => {
    // Codex #1243 T-48: the modal used to resolve the landing composer's
    // window-keyed pin ?? effective, so a new agent in an Epic served from B
    // landed on wherever the window's landing chip pointed. The placement now
    // resolves per Epic with the session's host as the default tier; this
    // pins the modal hands it exactly that - not the app-wide host, and not
    // nothing.
    renderModal();
    expect(testState.placementInputs.length).toBeGreaterThan(0);
    for (const input of testState.placementInputs) {
      expect(input).toEqual({
        epicId: "epic-1",
        overrideHostId: null,
        sessionHostId: "host-session",
      });
    }
  });

  it("scopes the workspace picker and the latest-workspace seed to the RESOLVED host, not the raw request", () => {
    // Codex #1243 T-50: the request is unnamed (`hostId: null`) and the
    // placement resolves it to host-a through the Epic's tiers. The picker
    // and the seed used to key on the raw request field, so they browsed and
    // seeded from the app-wide host while the create went to host-a.
    testState.placement.current = {
      resolvedHostId: "host-session",
      client: { getActiveHostId: () => "host-session" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    testState.followsEffective.current = false;
    renderModal();

    const scopes = testState.workspaceControlsElements.map(
      workspaceControlsHostScope,
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).toMatchObject({ kind: "fixed", hostId: "host-session" });
    }
    expect(testState.latestSeedPins.length).toBeGreaterThan(0);
    for (const pin of testState.latestSeedPins) {
      expect(pin).toMatchObject({ hostId: "host-session" });
    }
  });

  it("records the host it created on as the Epic's placement memory, on submit", () => {
    // "Last created chat's host": the create WRITES the per-Epic pin with the
    // host it resolved, at submit (beside the settings memory), so the next
    // new agent in this Epic opens on it - the model picker's memory shape.
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.recordPlacement).toHaveBeenCalledWith("host-a");
  });

  it("does NOT record a placement on a refused submit - nothing was created", () => {
    testState.placement.current = {
      ...testState.placement.current,
      client: { getActiveHostId: () => "host-moved" },
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.recordPlacement).not.toHaveBeenCalled();
  });
});
