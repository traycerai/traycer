/**
 * On a team's sandbox host only a harness whose credential stays a
 * placeholder may run. The in-task New conversation modal must hold both of
 * its creates to that rule: a Send with the selected chat harness blocked, and
 * a terminal launch whose `launch.harnessId` is blocked, create nothing, leave
 * the draft and the modal as the user left them, and say why in the
 * composer's refused notice. The gate is mocked as a per-test predicate, so
 * the suite decides which harness ids are blocked.
 */

import { useRef, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type {
  StagedResubmit,
  useStagedSandboxHandoff,
  useStagedSandboxSend,
} from "@/components/composer/use-staged-sandbox-send";
import type { SandboxStagingSurface } from "@/components/composer/use-sandbox-staging";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { TEAM_SANDBOX_HARNESS_UNAVAILABLE } from "@/lib/sandboxes/team-sandbox-harness";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import {
  NewConversationModalBody,
  NewConversationModalHost,
} from "../new-conversation-modal";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

const UNAVAILABLE_COPY = "Not available on team sandboxes.";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const gateState = vi.hoisted(() => ({
  blockedIds: new Set<string>(),
}));

// The image's bytes come from the composer's image store, read per test.
const imageStore = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));
/** One toast the person was shown, in the order it was shown. */
interface ShownToast {
  readonly via: "toast" | "error" | "info";
  readonly message: string;
}

const { toastLog } = vi.hoisted(() => ({ toastLog: [] as ShownToast[] }));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(
      (message: string): string => {
        toastLog.push({ via: "toast", message });
        return message;
      },
      actual.toast,
      {
        error: (message: string): string => {
          toastLog.push({ via: "error", message });
          return message;
        },
        info: (message: string): string => {
          toastLog.push({ via: "info", message });
          return message;
        },
      },
    ),
  };
});

function attachRefusal(code: HostRpcError["code"]): HostRpcError {
  return new HostRpcError({
    code,
    message: "This task cannot be attached to that team.",
    requestId: "request-attach-refused",
    method: "epic.attachEnvironment",
    fatalDetails: null,
  });
}

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/composer/landing-image-store")
  >()),
  getImageBytes: imageStore.getImageBytes,
}));

// The gates' own reads are covered by their hook tests; here the modal's use
// of their answers is what is under test.
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({
    blocked: testState.agentGateNotice !== null,
    hint:
      testState.agentGateNotice === null
        ? null
        : testState.agentGateNotice.message,
    notice: testState.agentGateNotice,
  }),
}));
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => testState.stagedNotice,
    beforeSend: testState.beforeStagedSend,
  }),
}));

vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => {
  const isBlocked = (harnessId: string): boolean =>
    gateState.blockedIds.has(harnessId);
  return {
    useTeamSandboxHarnessGate: () => isBlocked,
    useTeamSandboxHarnessBlocked: (input: {
      readonly harnessId: string | null;
    }): boolean => input.harnessId !== null && isBlocked(input.harnessId),
  };
});

interface PlacementTargetShape {
  readonly resolvedHostId: string | null;
  readonly client: {
    readonly getActiveHostId: () => string | null;
    readonly request: (method: string, payload: unknown) => Promise<unknown>;
  } | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  readonly namedHostDead: boolean;
}

function usablePlacement(): PlacementTargetShape {
  return {
    resolvedHostId: "host-a",
    client: {
      getActiveHostId: () => "host-a",
      request: (method, payload) => testState.hostRequest(method, payload),
    },
    hostLabel: "Studio Mac",
    isPinned: false,
    namedHostDead: false,
  };
}

type StagedSendInput = Parameters<typeof useStagedSandboxSend>[0];
type StagedHandoffInput = Parameters<typeof useStagedSandboxHandoff>[0];

const testState = vi.hoisted(() => ({
  /** What the modal hands its workspace controls to stage a sandbox with. */
  sandboxStaging: null as SandboxStagingSurface | null,
  /** What a sandbox host's agent gate says about the agent picked. */
  agentGateNotice: null as ComposerHostNoticeState | null,
  /** What the staged send's catalogue check says: `null` lets it through. */
  stagedNotice: null as ComposerHostNoticeState | null,
  beforeStagedSend: vi.fn<() => Promise<ComposerHostNoticeState | null>>(),
  /** Whether a sandbox is staged: the staged send then takes the Start. */
  staged: false,
  /** How many sends or Starts reached the staged send's intercept. */
  intercepts: 0,
  /** Whether the current host's workspace can start a send. */
  workspaceReady: true,
  /** What the modal hands the staged send on its latest render. */
  stagedSendInput: null as StagedSendInput | null,
  stagedHandoffInput: null as StagedHandoffInput | null,
  /** The resolved host's catalog: `null` until it answers. */
  catalogHostId: null as string | null,
  /** The resolved host's `providers.list`, `undefined` until it answers. */
  providers: undefined as
    | ReadonlyArray<{ readonly providerId: string; readonly profiles: [] }>
    | undefined,
  toolbarStore: null as { readonly setState: (patch: object) => void } | null,
  createChat: vi.fn<
    (request: { readonly hostId: string }) => Promise<{
      readonly initialTurnStarted: boolean;
    }>
  >(() => Promise.resolve({ initialTurnStarted: false })),
  attachEnvironment: vi.fn<
    (input: unknown) => Promise<{ readonly attached: true }>
  >(() => Promise.resolve({ attached: true })),
  /** Every host request the real attach hook sends; only the attach is served. */
  hostRequest: (method: string, payload: unknown): Promise<unknown> =>
    method === "epic.attachEnvironment"
      ? testState.attachEnvironment(payload)
      : Promise.reject(new Error(`unexpected ${method}`)),
  createTerminalAgent: vi.fn(() => Promise.resolve(null)),
  onSubmitted: vi.fn(),
  /** The editor's @/slash menu dismissal. */
  dismissSuggestion: vi.fn(() => false),
  bodySubmit: null as (() => void) | null,
  bodyStartTerminal: null as
    | ((launch: TerminalAgentLaunch, assembledFor: string | null) => void)
    | null,
  installEditor: null as (() => void) | null,
  /** How many composer bodies mounted: one per editor instance. */
  bodyMounts: 0,
  /** How many of them unmounted, letting their editor go. */
  bodyUnmounts: 0,
  /** What the editor holds. */
  editorContent: null as JsonContent | null,
  /** A toolbar popover the person left open in the composer. */
  toolbarPopoverOpen: false,
  placement: ((): { current: PlacementTargetShape } => ({
    current: {
      resolvedHostId: "host-a",
      client: {
        getActiveHostId: () => "host-a",
        request: (method: string, payload: unknown) =>
          testState.hostRequest(method, payload),
      },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    },
  }))(),
}));

function terminalLaunch(harnessId: TuiHarnessId): TerminalAgentLaunch {
  return {
    harnessId,
    model: null,
    reasoningEffort: null,
    terminalAgentArgs: null,
    profileId: null,
  };
}

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  const { Popover, PopoverAnchor, PopoverContent } =
    await import("@/components/ui/popover");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyStartTerminal = props.onStartTerminal;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      const { editorRef } = props;
      React.useEffect(() => {
        testState.bodyMounts += 1;
        return () => {
          // The editor's handle goes with it, as the real editor's does.
          testState.bodyUnmounts += 1;
          editorRef.current = null;
        };
      }, [editorRef]);
      return React.createElement(
        "div",
        { "data-testid": "composer-body-mock" },
        props.topBanner,
        props.workspaceControls,
        React.createElement(
          Popover,
          { open: testState.toolbarPopoverOpen },
          React.createElement(PopoverAnchor, null),
          React.createElement(
            PopoverContent,
            {},
            React.createElement(
              "span",
              { "data-testid": "toolbar-popover-mock" },
              "Models",
            ),
          ),
        ),
      );
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
    getJSON: () => testState.editorContent ?? DIRTY_CONTENT,
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
    dismissActiveSuggestion: () => testState.dismissSuggestion(),
    draftGeneration: () => 0,
  };
}

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => ({
    pin: {
      selection: null,
      honoredSelection: null,
      setSelection: () => undefined,
      resolvedHostId: "host-a",
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: testState.placement.current,
    submitTarget: testState.placement.current,
    hostLabelFor: () => "Studio Mac",
    followsEffective: true,
  }),
}));

const NO_MIRROR_LINE = vi.hoisted(() =>
  Object.freeze({ notice: null, markSeen: (): void => undefined }),
);
vi.mock("@/hooks/composer/use-composer-mirror-line", () => ({
  useComposerMirrorLine: () => NO_MIRROR_LINE,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-session",
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    mutateAsync: testState.createChat,
  }),
}));

vi.mock(
  "@/hooks/epic/use-epic-attach-environment-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-attach-environment-mutation")
      >();
    return {
      ...actual,
      // The real hook, on a client whose `epic.attachEnvironment` is the
      // test's: its refusal copy is what the person reads.
      useEpicAttachEnvironment: actual.useEpicAttachEnvironment,
    };
  },
);

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    isPending: false,
    create: testState.createTerminalAgent,
  }),
}));

vi.mock("@/lib/composer/repointed-staging-toast", () => ({
  toastRepointedStagingReset: () => undefined,
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore(() => ({
    ultracode: false,
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    // The raw pick; `selection` above is what this host's catalog shows.
    values: {
      ultracode: false,
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-6.1-sol",
        profileId: null,
      },
      permission: "supervised",
      reasoning: "high",
      serviceTier: "",
    },
    selectedModel: null,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
    get catalog() {
      return testState.catalogHostId === null
        ? { hostId: null, harnesses: undefined, modelsLoaded: false }
        : {
            hostId: testState.catalogHostId,
            harnesses: [],
            modelsLoaded: true,
          };
    },
  }));
  testState.toolbarStore = store;
  return { useComposerToolbarStore: () => store };
});

vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/providers/use-providers-list-query")
    >()),
    useProvidersListForClient: () => ({
      data:
        testState.providers === undefined
          ? undefined
          : { providers: testState.providers },
      isError: false,
    }),
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicTitle: () => "Epic",
}));

const stubHostClient = {
  request: (method: string, payload: unknown): Promise<unknown> =>
    testState.hostRequest(method, payload),
  getActiveHostId: () => "host-a",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
// The staged send itself has its own suite: here it takes a send or a Start
// only while `testState.staged` says a sandbox is staged, and keeps a Start's
// launch on the stage as the real one does.
vi.mock(
  "@/components/composer/use-staged-sandbox-send",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/composer/use-staged-sandbox-send")
      >();
    const { useStagedSandboxStore } =
      await import("@/stores/composer/staged-sandbox-store");
    return {
      // Phase 1 stands in for the run: the send is taken and the boot begins.
      useStagedSandboxSend: (input: StagedSendInput) => {
        testState.stagedSendInput = input;
        return {
          intercept: (
            _messageText: string,
            terminalLaunch: TerminalAgentLaunch | null,
          ): boolean => {
            testState.intercepts += 1;
            if (!testState.staged || input.surfaceKey === null) return false;
            const store = useStagedSandboxStore.getState();
            // On the new host the resubmit is the surface's own send.
            if (store.bySurface[input.surfaceKey]?.phase === "handoff") {
              return false;
            }
            store.report(input.surfaceKey, {
              ownerId: input.ownerId,
              terminalLaunch,
              sendTaken: true,
            });
            store.begin(input.surfaceKey, false, Date.now(), false);
            return true;
          },
          line: null,
        };
      },
      // Phase 2 is the real one.
      useStagedSandboxHandoff: (input: StagedHandoffInput) => {
        testState.stagedHandoffInput = input;
        actual.useStagedSandboxHandoff(input);
      },
    };
  },
);
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
  workspaceComposerCanStart: () => testState.workspaceReady,
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
      testState.sandboxStaging = props.sandboxStaging;
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
  );
}

function QueryWrapper({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createAppQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderModal(): RenderResult {
  const view = render(<Harness />, { wrapper: QueryWrapper });
  act(() => {
    testState.installEditor?.();
  });
  return view;
}

function draftSurvived(): boolean {
  const patch =
    useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
  return patch?.content !== undefined && patch.content !== null;
}

function expectUnavailableNotice(): void {
  const notice = screen.getByTestId("composer-host-notice");
  expect(notice.getAttribute("data-notice-kind")).toBe("refused");
  expect(notice.textContent).toBe(UNAVAILABLE_COPY);
}

beforeEach(() => {
  testState.beforeStagedSend.mockReset();
  testState.beforeStagedSend.mockImplementation(() =>
    Promise.resolve(testState.stagedNotice),
  );
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
  testState.placement.current = usablePlacement();
  gateState.blockedIds.clear();
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  testState.createChat.mockClear();
  testState.attachEnvironment.mockReset();
  testState.attachEnvironment.mockResolvedValue({ attached: true });
  testState.createTerminalAgent.mockClear();
  testState.onSubmitted.mockClear();
  testState.dismissSuggestion.mockClear();
  testState.bodySubmit = null;
  testState.bodyStartTerminal = null;
  testState.staged = false;
  testState.intercepts = 0;
  testState.workspaceReady = true;
  testState.stagedSendInput = null;
  testState.stagedHandoffInput = null;
  testState.agentGateNotice = null;
  testState.stagedNotice = null;
  testState.sandboxStaging = null;
  testState.bodyMounts = 0;
  testState.bodyUnmounts = 0;
  testState.editorContent = null;
  imageStore.getImageBytes.mockReset();
  imageStore.getImageBytes.mockResolvedValue(undefined);
  testState.toolbarPopoverOpen = false;
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useNewConversationModalOpenStore.getState().close();
  testState.catalogHostId = null;
  testState.providers = undefined;
  // A case's answer stays on the shared toolbar store until it is unset.
  testState.toolbarStore?.setState({
    catalog: { hostId: null, harnesses: undefined, modelsLoaded: false },
    values: {
      ultracode: false,
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-6.1-sol",
        profileId: null,
      },
      permission: "supervised",
      reasoning: "high",
      serviceTier: "",
    },
  });
  gateState.blockedIds.clear();
  useNewConversationModalStore.getState().resetForTests();
});

describe("new-conversation modal holds its creates to the team-sandbox harness rule", () => {
  it("carries the agreed refusal copy", () => {
    expect(TEAM_SANDBOX_HARNESS_UNAVAILABLE).toBe(UNAVAILABLE_COPY);
  });

  it("creates once when the selected chat harness is not blocked (control)", () => {
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("creates no chat, shows the refused notice and keeps the draft when the selected chat harness is blocked", () => {
    gateState.blockedIds.add("claude");
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expectUnavailableNotice();
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("starts a terminal agent once when the launch harness is not blocked (control)", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    renderModal();
    act(() => {
      testState.bodyStartTerminal?.(terminalLaunch("claude"), "host-a");
    });

    expect(testState.createTerminalAgent).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("creates no terminal agent, shows the refused notice and keeps the draft when launch.harnessId is blocked", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    // The toolbar's own selection ("claude") is NOT blocked: the launch's
    // harness is the one the rule has to read.
    gateState.blockedIds.add("codex");
    renderModal();
    act(() => {
      testState.bodyStartTerminal?.(terminalLaunch("codex"), "host-a");
    });

    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
    expectUnavailableNotice();
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });
});

const SANDBOX_SURFACE = newConversationSurfaceKey("epic-1");

const NEW_SANDBOX: StagedSandboxTarget = {
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

const TEAM_SANDBOX: StagedSandboxTarget = {
  ...NEW_SANDBOX,
  configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
};

function onlyPendingSend() {
  const sends = Object.values(usePendingSandboxSendStore.getState().sends);
  expect(sends).toHaveLength(1);
  return sends[0];
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("new-conversation modal refusals at Send", () => {
  const SENTENCE =
    "Traycer Inference setup failed - not enough disk space. Free some space, then retry.";

  function refusal(onAction: () => void, message: string, label: string) {
    return {
      kind: "refused" as const,
      message,
      action: { label, onAction },
    };
  }

  it("refuses an agent that cannot run on the sandbox host with the Providers link, creating nothing and keeping the draft", () => {
    const openProviders = vi.fn();
    testState.agentGateNotice = refusal(
      openProviders,
      SENTENCE,
      "Open Personal's Providers",
    );
    renderModal();

    act(() => {
      testState.bodySubmit?.();
    });

    const notice = screen.getByTestId("composer-host-notice");
    expect(notice.textContent).toContain(SENTENCE);
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("composer-host-notice-action"));
    expect(openProviders).toHaveBeenCalledTimes(1);
  });

  it("refuses a staged send when its requested agent is not offered, before any create or wake", async () => {
    const chooseModel = vi.fn();
    testState.stagedNotice = refusal(
      chooseModel,
      "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      "Choose a model",
    );
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX);
    });

    act(() => {
      testState.bodySubmit?.();
    });

    expect(
      (await screen.findByTestId("composer-host-notice")).textContent,
    ).toContain(
      "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
    );
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
      [],
    );
    expect(readStagedSandbox(SANDBOX_SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: null,
    });
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose a model" }));
    expect(chooseModel).toHaveBeenCalledTimes(1);
  });

  it("clears a staged refusal once the pick can run, without another Send", async () => {
    testState.stagedNotice = refusal(
      vi.fn(),
      "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      "Choose a model",
    );
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX);
    });
    act(() => {
      testState.bodySubmit?.();
    });
    await screen.findByTestId("composer-host-notice");

    // The person picks a Traycer model: the stage's check no longer refuses.
    testState.stagedNotice = null;
    act(() =>
      testState.toolbarStore?.setState({
        values: {
          ultracode: false,
          selection: {
            harnessId: "traycer",
            modelSlug: "claude-sonnet-5.5",
            profileId: null,
          },
          permission: "supervised",
          reasoning: "high",
          serviceTier: "",
        },
      }),
    );

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    expect(testState.beforeStagedSend).toHaveBeenCalledOnce();
  });

  it("hands the same staged send over when the agent is signed in", async () => {
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX);
    });

    act(() => {
      testState.bodySubmit?.();
    });

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    await waitFor(() =>
      expect(
        Object.keys(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1),
    );
  });
});

describe("new-conversation modal's send on a staged sandbox", () => {
  it("keeps a changed selection while the staged Send check is pending", async () => {
    const checked = deferred<ComposerHostNoticeState | null>();
    testState.beforeStagedSend.mockReturnValue(checked.promise);
    renderModal();
    act(() =>
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX),
    );
    act(() => testState.bodySubmit?.());
    expect(testState.beforeStagedSend).toHaveBeenCalledOnce();
    act(() =>
      testState.toolbarStore?.setState({
        values: {
          ultracode: false,
          selection: {
            harnessId: "claude",
            modelSlug: "opus",
            profileId: null,
          },
          permission: "supervised",
          reasoning: "high",
          serviceTier: "",
        },
      }),
    );
    await act(async () => {
      checked.resolve(null);
      await checked.promise;
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(testState.onSubmitted).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
  });

  it("attaches a team-staged chat before handing its draft to the sandbox", async () => {
    const attach = deferred<{ readonly attached: true }>();
    testState.attachEnvironment.mockReturnValue(attach.promise);
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, TEAM_SANDBOX);
      testState.bodySubmit?.();
    });

    await waitFor(() => {
      expect(testState.attachEnvironment).toHaveBeenCalledWith({
        epicId: "epic-1",
        teamId: "team-9",
      });
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SANDBOX_SURFACE)).toMatchObject({
      target: TEAM_SANDBOX,
    });
    expect(draftSurvived()).toBe(true);
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.onSubmitted).not.toHaveBeenCalled();

    await act(async () => {
      attach.resolve({ attached: true });
      await attach.promise;
    });
    await waitFor(() => {
      expect(
        Object.values(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1);
    });
    expect(onlyPendingSend()).toMatchObject({
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
    });
    expect(testState.onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("attaches a team-staged terminal request before taking the stage", async () => {
    const attach = deferred<{ readonly attached: true }>();
    testState.attachEnvironment.mockReturnValue(attach.promise);
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, TEAM_SANDBOX);
    });
    const openTerminalInstead = testState.sandboxStaging?.openTerminalInstead;
    if (openTerminalInstead === null || openTerminalInstead === undefined) {
      throw new Error("expected the modal to offer Open terminal instead");
    }

    act(() => {
      openTerminalInstead();
    });
    await waitFor(() => {
      expect(testState.attachEnvironment).toHaveBeenCalledWith({
        epicId: "epic-1",
        teamId: "team-9",
      });
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SANDBOX_SURFACE)).toMatchObject({
      target: TEAM_SANDBOX,
    });

    await act(async () => {
      attach.resolve({ attached: true });
      await attach.promise;
    });
    await waitFor(() => {
      expect(
        Object.values(usePendingSandboxSendStore.getState().sends),
      ).toHaveLength(1);
    });
    expect(onlyPendingSend()).toMatchObject({
      epicId: "epic-1",
      request: { kind: "terminal" },
    });
    expect(testState.onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("keeps the staged chat and draft when its team attachment is refused", async () => {
    const attach = deferred<{ readonly attached: true }>();
    testState.attachEnvironment.mockReturnValue(attach.promise);
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, TEAM_SANDBOX);
      testState.bodySubmit?.();
    });

    await waitFor(() => {
      expect(testState.attachEnvironment).toHaveBeenCalledWith({
        epicId: "epic-1",
        teamId: "team-9",
      });
    });
    await act(async () => {
      attach.reject(
        new HostRpcError({
          code: "FORBIDDEN",
          message: "This task cannot be attached to that team.",
          requestId: "request-attach-refused",
          method: "epic.attachEnvironment",
          fatalDetails: null,
        }),
      );
      await attach.promise.catch(() => undefined);
    });

    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SANDBOX_SURFACE)).toMatchObject({
      target: TEAM_SANDBOX,
    });
    expect(draftSurvived()).toBe(true);
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a task still being set up",
      attachRefusal("E_SHARE_PENDING_BUSY"),
      [
        {
          via: "error",
          message: "This task is still being set up. Send again in a moment.",
        },
      ],
    ],
    [
      "a plain failure",
      attachRefusal("RPC_ERROR"),
      [{ via: "error", message: "Couldn't send your message." }],
    ],
    [
      "a task that could not be shared (offline)",
      attachRefusal("E_SHARE_PENDING_OFFLINE"),
      [{ via: "error", message: "Couldn't send your message." }],
    ],
    [
      "a refused permission",
      attachRefusal("FORBIDDEN"),
      [
        {
          via: "error",
          message: "Ask the task's owner to continue it on a team host.",
        },
      ],
    ],
    [
      "a host out of disk space",
      attachRefusal("E_HOST_STORAGE_FULL"),
      [
        {
          via: "error",
          message:
            "The host computer is out of disk space. Free some space on it, then try again.",
        },
      ],
    ],
    [
      "a transport failure",
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "Host is unreachable",
        requestId: "request-attach-transport",
        method: "epic.attachEnvironment",
        fatalDetails: null,
      }),
      [{ via: "toast", message: "Couldn't send your message." }],
    ],
    [
      "an aborted request",
      new HostRequestAbortedError({
        message: "authority replaced",
        requestId: "request-attach-abort",
        method: "epic.attachEnvironment",
        mayHaveDispatched: false,
      }),
      [],
    ],
  ] as const)(
    "tells exactly what a Send refused for %s says, and creates no chat",
    async (_label, error, expected) => {
      toastLog.length = 0;
      const attach = deferred<{ readonly attached: true }>();
      testState.attachEnvironment.mockReturnValue(attach.promise);
      renderModal();
      act(() => {
        useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, TEAM_SANDBOX);
        testState.bodySubmit?.();
      });
      await waitFor(() => {
        expect(testState.attachEnvironment).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        attach.reject(error);
        await attach.promise.catch(() => undefined);
      });

      if (expected.length > 0) {
        await waitFor(() => {
          expect(toastLog).toHaveLength(expected.length);
        });
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(toastLog).toEqual(expected);
      expect(testState.createChat).not.toHaveBeenCalled();
      expect(testState.onSubmitted).not.toHaveBeenCalled();
      expect(draftSurvived()).toBe(true);
    },
  );

  it("keeps the staged chat and draft when the account changes during attachment", async () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "modal-user", userName: "Modal", email: "modal@example.com" },
        { userId: "modal-user", username: "Modal" },
        [],
      );
    const attach = deferred<{ readonly attached: true }>();
    testState.attachEnvironment.mockReturnValue(attach.promise);
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, TEAM_SANDBOX);
      testState.bodySubmit?.();
    });

    await waitFor(() => {
      expect(testState.attachEnvironment).toHaveBeenCalledWith({
        epicId: "epic-1",
        teamId: "team-9",
      });
    });
    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "other-user",
          userName: "Other",
          email: "other@example.com",
        },
        { userId: "other-user", username: "Other" },
        [],
      );
    });
    await act(async () => {
      attach.resolve({ attached: true });
      await attach.promise;
    });

    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SANDBOX_SURFACE)).toMatchObject({
      target: TEAM_SANDBOX,
    });
    expect(draftSurvived()).toBe(true);
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("hands the send to this task and closes, though this host's workspace folder is unresolved", async () => {
    // The sandbox starts empty: the chip reads Empty sandbox and the
    // workspace controls are hidden.
    testState.workspaceReady = false;
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX);
    });

    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.intercepts).toBe(0);
    await waitFor(() => expect(testState.onSubmitted).toHaveBeenCalledTimes(1));
    expect(onlyPendingSend()).toMatchObject({
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
    });
    // The stage went with it, under the send's own key.
    expect(readStagedSandbox(SANDBOX_SURFACE)).toBeNull();
    expect(
      readStagedSandbox(pendingSendSurfaceKey(onlyPendingSend().id)),
    ).not.toBeNull();
  });

  // The toolbar shows Claude here: the pick is Codex · GPT-6.1-Sol · High.
  it.each([
    [
      "a suspended sandbox",
      {
        kind: "existing",
        hostId: "host-a",
        sandboxId: "sbx-1",
        name: "build-box",
        configuration: { kind: "personal" },
        verb: "resume",
      },
    ],
    [
      "a stopped sandbox",
      {
        kind: "existing",
        hostId: "host-a",
        sandboxId: "sbx-1",
        name: "build-box",
        configuration: { kind: "personal" },
        verb: "start",
      },
    ],
    ["a new sandbox", NEW_SANDBOX],
  ] as const)(
    "sends to %s on the model the person picked, not the one the toolbar shows",
    async (_label, target) => {
      renderModal();
      act(() => {
        useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, target);
      });

      act(() => {
        testState.bodySubmit?.();
      });

      await waitFor(() =>
        expect(onlyPendingSend().settings).toMatchObject({
          harnessId: "codex",
          model: "gpt-6.1-sol",
          reasoningEffort: "high",
        }),
      );
    },
  );

  it("opens a terminal on the staged sandbox from Open terminal instead, with no agent sent", () => {
    renderModal();
    act(() => {
      useStagedSandboxStore.getState().stage(SANDBOX_SURFACE, NEW_SANDBOX);
    });
    const openTerminalInstead = testState.sandboxStaging?.openTerminalInstead;
    if (openTerminalInstead === null || openTerminalInstead === undefined) {
      throw new Error("expected the modal to offer Open terminal instead");
    }

    act(() => {
      openTerminalInstead();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(onlyPendingSend()).toMatchObject({
      epicId: "epic-1",
      request: { kind: "terminal" },
    });
    expect(testState.onSubmitted).toHaveBeenCalledTimes(1);
    // The stage is the same one: its create key travels with it.
    expect(
      readStagedSandbox(pendingSendSurfaceKey(onlyPendingSend().id)),
    ).toMatchObject({ target: NEW_SANDBOX });
  });

  it("drops the folders picked on the old host before the resubmit on the new one", () => {
    const store = useNewConversationModalStore.getState();
    store.addResolvedFolders(
      "epic-1",
      { folders: [], folderInfoByPath: {}, primaryPath: null },
      [
        {
          path: "/Users/me/api",
          name: "api",
          repoIdentifier: null,
          hostId: "host-a",
        },
      ],
    );
    renderModal();
    const input = testState.stagedHandoffInput;
    if (input === null) throw new Error("expected the staged handoff");

    act(() => {
      input.prepareHandoff("sbx-host");
    });

    const patch =
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
    expect(patch?.workspace).toBeNull();
    expect(draftSurvived()).toBe(true);
  });
});

describe("new-conversation modal's terminal Start on a staged sandbox", () => {
  it("creates no terminal agent here, then launches it on the new host as the person put it together, across a close and reopen", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    testState.staged = true;
    const view = renderModal();
    const surfaceKey = testState.stagedSendInput?.surfaceKey ?? null;
    if (surfaceKey === null) throw new Error("expected a staging surface");
    useStagedSandboxStore.getState().stage(surfaceKey, {
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
    });
    act(() => {
      testState.bodyStartTerminal?.(
        {
          harnessId: "claude",
          model: "old-host-model",
          reasoningEffort: "high",
          terminalAgentArgs: "--resume",
          profileId: "old-host-profile",
        },
        "host-a",
      );
    });
    expect(testState.createTerminalAgent).not.toHaveBeenCalled();

    // The modal closes while the sandbox boots, and opens again.
    view.unmount();
    renderModal();
    const staged = () => {
      const input = testState.stagedHandoffInput;
      if (input === null) throw new Error("expected the staged handoff");
      return input;
    };
    // The new host's catalog has not answered: no launch yet.
    expect(staged().canSubmit).toBe(false);

    // It answers, and its providers hold no managed profile for the harness.
    act(() => {
      testState.catalogHostId = "host-a";
      testState.providers = [{ providerId: "claude-code", profiles: [] }];
      testState.toolbarStore?.setState({
        catalog: {
          hostId: "host-a",
          harnesses: [{ id: "claude", available: true, modes: ["gui", "tui"] }],
          modelsLoaded: true,
        },
      });
    });
    expect(staged().canSubmit).toBe(true);
    let launched: StagedResubmit = false;
    act(() => {
      launched = staged().submit();
    });

    expect(launched).toBe(true);
    expect(testState.createTerminalAgent).toHaveBeenCalledTimes(1);
    expect(testState.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "claude",
        model: "old-host-model",
        reasoningEffort: "high",
        terminalAgentArgs: "--resume",
        profileId: null,
      }),
    );
  });
});

describe("new-conversation modal host while a staged sandbox boots a terminal agent", () => {
  const SURFACE = newConversationSurfaceKey("epic-1");

  function host(active: boolean) {
    return (
      <SurfacePresentationBoundary visible focused>
        <NewConversationModalHost
          epicId="epic-1"
          tabId="tab-1"
          active={active}
        />
      </SurfacePresentationBoundary>
    );
  }

  function renderHost(): RenderResult {
    return render(host(true), { wrapper: QueryWrapper });
  }

  function setOpen(open: boolean, parentId: string | null): void {
    act(() => {
      if (open) {
        useNewConversationModalOpenStore.getState().open({
          epicId: "epic-1",
          tabId: "tab-1",
          placement: null,
          parentId,
          hostId: null,
        });
      } else {
        useNewConversationModalOpenStore.getState().close();
      }
    });
  }

  /** Opens the modal, stages a sandbox and starts a terminal agent: the boot begins. */
  function sendOnStagedSandbox(): void {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    setOpen(true, null);
    act(() => {
      testState.installEditor?.();
    });
    testState.staged = true;
    const surfaceKey = testState.stagedSendInput?.surfaceKey ?? null;
    expect(surfaceKey).toBe(SURFACE);
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, {
        kind: "existing",
        hostId: "host-a",
        sandboxId: "sbx-1",
        name: "build-box",
        configuration: { kind: "personal" },
        verb: "resume",
      });
    });
    act(() => {
      testState.bodyStartTerminal?.(terminalLaunch("claude"), "host-a");
    });
    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
  }

  function bodies(): HTMLElement[] {
    return screen.queryAllByTestId("composer-body-mock");
  }

  it("launches from the closed modal once the sandbox is ready, then lets the body go", () => {
    renderHost();
    sendOnStagedSandbox();

    setOpen(false, null);
    expect(
      screen.queryByTestId("epic-sidebar-new-conversation-modal"),
    ).toBeNull();
    // Kept, detached: one editor, owning nothing on screen.
    expect(testState.bodyMounts).toBe(1);
    expect(bodies()).toHaveLength(0);

    // The new host answers: the hidden body's launch runs.
    handOff(true);

    expect(testState.createTerminalAgent).toHaveBeenCalledTimes(1);
    expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toBeUndefined();
    // Reopening now is a fresh body: the old one was released with the stage.
    setOpen(true, null);
    expect(testState.bodyMounts).toBe(2);
  });

  it("shows the same body again when reopened while the sandbox boots, and owns no shortcut while hidden", () => {
    renderHost();
    sendOnStagedSandbox();
    setOpen(false, null);

    // Cmd+Enter while hidden reaches no send.
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(testState.intercepts).toBe(1);

    setOpen(true, null);
    expect(testState.bodyMounts).toBe(1);
    const shown = bodies();
    expect(shown).toHaveLength(1);
    expect(
      within(
        screen.getByTestId("epic-sidebar-new-conversation-modal-body"),
      ).getByTestId("composer-body-mock"),
    ).toBe(shown[0]);
  });

  it("keeps the Start through a tab switch, and releases the body when the stage is cleared", () => {
    const view = renderHost();
    sendOnStagedSandbox();

    // The tab goes to the background: its modal closes, its send does not.
    view.rerender(host(false));
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(testState.bodyMounts).toBe(1);
    view.rerender(host(true));
    setOpen(true, null);
    expect(testState.bodyMounts).toBe(1);

    // An account switch clears every stage: nothing is left to send.
    setOpen(false, null);
    act(() => {
      useStagedSandboxStore.getState().clearAll();
    });
    setOpen(true, null);
    expect(testState.bodyMounts).toBe(2);
    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
  });

  /** The stage hands off; the new host's catalog answers when `answer`. */
  function handOff(answer: boolean): void {
    if (!answer) {
      // An earlier case's answer stays on the shared toolbar store.
      testState.toolbarStore?.setState({
        catalog: { hostId: null, harnesses: undefined, modelsLoaded: false },
      });
    }
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        createdHostId: "host-a",
        phase: "handoff",
      });
    });
    if (!answer) return;
    act(() => {
      testState.catalogHostId = "host-a";
      testState.providers = [{ providerId: "claude-code", profiles: [] }];
      testState.toolbarStore?.setState({
        catalog: {
          hostId: "host-a",
          harnesses: [{ id: "claude", available: true, modes: ["gui", "tui"] }],
          modelsLoaded: true,
        },
      });
    });
  }

  it("closes its @/slash menu when it hides with the Start still booting", () => {
    renderHost();
    sendOnStagedSandbox();
    expect(testState.dismissSuggestion).not.toHaveBeenCalled();

    setOpen(false, null);

    expect(testState.dismissSuggestion).toHaveBeenCalledTimes(1);
  });

  it("un-presents a toolbar popover left open when the modal hides without input, and shows it again on reopen", () => {
    testState.toolbarPopoverOpen = true;
    renderHost();
    sendOnStagedSandbox();
    expect(screen.getByTestId("toolbar-popover-mock")).toBeDefined();

    // A tab activated from outside the page (a notification): no click or
    // focus move dismissed the popover.
    setOpen(false, null);
    expect(screen.queryByTestId("toolbar-popover-mock")).toBeNull();

    setOpen(true, null);
    expect(screen.getByTestId("toolbar-popover-mock")).toBeDefined();
  });

  it("keeps the modal open for a click inside a toolbar popover, and closes it for one on the overlay", async () => {
    testState.toolbarPopoverOpen = true;
    renderHost();
    setOpen(true, null);
    const popoverContent = screen.getByTestId("toolbar-popover-mock");

    // Radix arms its document listener, and runs a deferred outside click, on
    // a zero-delay timer.
    const flushTimers = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const clickAt = async (target: Element) => {
      fireEvent.pointerDown(target, {
        pointerType: "mouse",
        button: 0,
        bubbles: true,
      });
      fireEvent.click(target, { bubbles: true });
      await flushTimers();
    };

    await flushTimers();
    // The popover portals to document.body: outside the dialog's DOM, inside
    // the body's React tree.
    await clickAt(popoverContent);
    expect(useNewConversationModalOpenStore.getState().request).not.toBeNull();
    expect(
      screen.getByTestId("epic-sidebar-new-conversation-modal"),
    ).toBeDefined();

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (overlay === null) throw new Error("expected the dialog overlay");
    await clickAt(overlay);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });

  it("holds a request filed while the Start is handed off, and keeps it open after the launch", () => {
    renderHost();
    sendOnStagedSandbox();
    setOpen(false, null);
    // Another trigger (a row's new child) while the sandbox boots.
    setOpen(true, "chat-parent");
    const filed = useNewConversationModalOpenStore.getState().request;

    handOff(true);

    expect(testState.createTerminalAgent).toHaveBeenCalledTimes(1);
    expect(useNewConversationModalOpenStore.getState().request).toBe(filed);
    expect(
      screen.getByTestId("epic-sidebar-new-conversation-modal"),
    ).toBeDefined();
  });

  it("drops the automatic launch when its tab closes before the resubmit, keeping the draft", async () => {
    const view = renderHost();
    sendOnStagedSandbox();
    setOpen(false, null);
    handOff(false);
    expect(useStagedSandboxStore.getState().bySurface[SURFACE]?.phase).toBe(
      "handoff",
    );

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toBeUndefined();
    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
  });

  it("shows a request filed for a background tab once the tab comes to the front", () => {
    // Filed before the tab's session mounts in the background.
    setOpen(true, null);
    const view = render(host(false), { wrapper: QueryWrapper });
    expect(
      screen.queryByTestId("epic-sidebar-new-conversation-modal"),
    ).toBeNull();

    view.rerender(host(true));
    expect(
      screen.getByTestId("epic-sidebar-new-conversation-modal"),
    ).toBeDefined();
  });
});
