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
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type { useStagedSandboxSend } from "@/components/composer/use-staged-sandbox-send";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { TEAM_SANDBOX_HARNESS_UNAVAILABLE } from "@/lib/sandboxes/team-sandbox-harness";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

const UNAVAILABLE_COPY = "Not available on team sandboxes.";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const gateState = vi.hoisted(() => ({
  blockedIds: new Set<string>(),
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
  readonly client: { readonly getActiveHostId: () => string | null } | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  readonly namedHostDead: boolean;
}

function usablePlacement(): PlacementTargetShape {
  return {
    resolvedHostId: "host-a",
    client: { getActiveHostId: () => "host-a" },
    hostLabel: "Studio Mac",
    isPinned: false,
    namedHostDead: false,
  };
}

type StagedSendInput = Parameters<typeof useStagedSandboxSend>[0];

const testState = vi.hoisted(() => ({
  /** Whether a sandbox is staged: the staged send then takes the Start. */
  staged: false,
  /** What the modal hands the staged send on its latest render. */
  stagedSendInput: null as StagedSendInput | null,
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
  createTerminalAgent: vi.fn(() => Promise.resolve(null)),
  onSubmitted: vi.fn(),
  bodySubmit: null as (() => void) | null,
  bodyStartTerminal: null as
    | ((launch: TerminalAgentLaunch, assembledFor: string | null) => void)
    | null,
  installEditor: null as (() => void) | null,
  placement: ((): { current: PlacementTargetShape } => ({
    current: {
      resolvedHostId: "host-a",
      client: { getActiveHostId: () => "host-a" },
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
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyStartTerminal = props.onStartTerminal;
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
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
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
  getActiveHostId: () => "host-a",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
// The staged send itself has its own suite: here it takes a send or a Start
// only while `testState.staged` says a sandbox is staged, and keeps a Start's
// launch on the stage as the real one does.
vi.mock("@/components/composer/use-staged-sandbox-send", async () => {
  const { useStagedSandboxStore } =
    await import("@/stores/composer/staged-sandbox-store");
  return {
    useStagedSandboxSend: (input: StagedSendInput) => {
      testState.stagedSendInput = input;
      return {
        intercept: (
          _messageText: string,
          terminalLaunch: TerminalAgentLaunch | null,
        ): boolean => {
          if (!testState.staged || input.surfaceKey === null) return false;
          useStagedSandboxStore
            .getState()
            .report(input.surfaceKey, { terminalLaunch });
          return true;
        },
        line: null,
      };
    },
  };
});
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
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
  testState.placement.current = usablePlacement();
  gateState.blockedIds.clear();
});

afterEach(() => {
  cleanup();
  testState.createChat.mockClear();
  testState.createTerminalAgent.mockClear();
  testState.onSubmitted.mockClear();
  testState.bodySubmit = null;
  testState.bodyStartTerminal = null;
  testState.staged = false;
  testState.stagedSendInput = null;
  useStagedSandboxStore.setState({ bySurface: {} });
  testState.catalogHostId = null;
  testState.providers = undefined;
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

describe("new-conversation modal's terminal Start on a staged sandbox", () => {
  it("creates no terminal agent here, then launches it on the new host with what that host offers, across a close and reopen", () => {
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
      const input = testState.stagedSendInput;
      if (input === null) throw new Error("expected the staged send");
      return input;
    };
    // The new host's catalog has not answered: no launch yet.
    expect(staged().canSubmit).toBe(false);

    // It answers, and its providers hold no managed profile for the harness.
    act(() => {
      testState.catalogHostId = "host-a";
      testState.providers = [{ providerId: "claude-code", profiles: [] }];
      testState.toolbarStore?.setState({});
    });
    expect(staged().canSubmit).toBe(true);
    let launched = false;
    act(() => {
      launched = staged().submit();
    });

    expect(launched).toBe(true);
    expect(testState.createTerminalAgent).toHaveBeenCalledTimes(1);
    expect(testState.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
        terminalAgentArgs: "--resume",
        profileId: null,
      }),
    );
  });
});
