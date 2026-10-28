import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPrestartRuntimeRequest } from "@traycer/protocol/host/agent/gui/prestart-runtime";

import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { ChatComposer } from "../chat-composer";

/**
 * The runtime pre-start trigger, through the REAL `ChatComposer` and a real
 * reactive toolbar store.
 *
 * `chat.prestartRuntime` fires on the person's input into the focused composer
 * when the draft was empty before it, and on a toolbar settings change made by
 * the person while the draft is non-empty. It never fires on focus alone, on a
 * restored draft, on settings the app applies, while a worktree is staged, or
 * against a host that does not serve the method.
 *
 * Stand-ins, all unrelated to the trigger: the host/tab/epic/draft/gate hooks
 * and every child surface. The editor slot is replaced by a probe that hands
 * the test the `onUserInput` the composer gave it; the prestart mutation is
 * replaced by a spy on `mutate`.
 */

const captured = vi.hoisted(() => ({
  /** What a sandbox host's agent gate says about the agent picked. */
  agentNotice: null as {
    readonly kind: "refused";
    readonly message: string;
    readonly action: {
      readonly label: string;
      readonly onAction: () => void;
    } | null;
  } | null,
  /** The pack gate's hint; the pack gate's wait outranks the refusal. */
  packHint: null as string | null,
  onUserInput: null as ((wasEmpty: boolean) => void) | null,
  mutate: vi.fn<(request: ChatPrestartRuntimeRequest) => void>(),
  support: true as boolean | null,
  paneFocused: true,
  draftHasText: false,
  stagedWorktree: false,
  /** The sandbox this chat's next message wakes, while it rests. */
  resting: null as RestingChatSandbox | null,
  toolbarStore: null as {
    readonly getState: () => {
      readonly setSelection: (next: {
        readonly harnessId: "claude";
        readonly modelSlug: string;
        readonly profileId: string | null;
      }) => void;
      readonly applySeed: (
        seedKey: string,
        values: {
          readonly permission: "supervised";
          readonly selection: {
            readonly harnessId: "claude";
            readonly modelSlug: string;
            readonly profileId: string | null;
          };
          readonly reasoning: string;
          readonly serviceTier: string;
        },
      ) => void;
    };
  } | null,
}));

// A chat composer on a sandbox host refuses an unrunnable agent at Send;
// nothing in this suite sits on one, nor on a resting sandbox's chat.
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({
    blocked: captured.agentNotice !== null,
    hint: captured.agentNotice === null ? null : captured.agentNotice.message,
    notice: captured.agentNotice,
  }),
  useRestingSandboxAgentGate: () => ({
    blocked: false,
    hint: null,
    notice: null,
  }),
}));

vi.mock("@/hooks/chats/use-chat-prestart-runtime", () => ({
  useChatPrestartRuntime: () => ({ mutate: captured.mutate }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => captured.support,
}));
vi.mock("@/stores/worktree/worktree-intent-staging-store", async (original) => {
  const actual =
    await original<
      typeof import("@/stores/worktree/worktree-intent-staging-store")
    >();
  return {
    ...actual,
    readStagedWorktreeIntent: (
      ...args: Parameters<typeof actual.readStagedWorktreeIntent>
    ) =>
      captured.stagedWorktree
        ? { kind: "new" as const }
        : actual.readStagedWorktreeIntent(...args),
  };
});
vi.mock("../picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => ({
  useComposerToolbarStore: () => captured.toolbarStore,
}));

async function createToolbarStore(modelSlug: string) {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "chat-composer-picker-profile-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug,
        profileId: "profile-a",
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

vi.mock("@/lib/layout-overrides", () => ({
  useReadingWidthStyle: () => ({ className: "", maxWidth: "100%" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ fileDrops: {} }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({}),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useWorkspaceMentionRoots: () => ["/repo"],
}));
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useEpicAttachmentBytesPresence: () => null,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneFocused: () => captured.paneFocused,
}));
vi.mock("@/components/epic-canvas/canvas/tab-body-selected-context", () => ({
  useTabBodySelected: () => true,
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useMaybeEpicStore: () => null,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  workspaceComposerCanStart: () => true,
}));
vi.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: () => ({
    initialContent: null,
    initialSelection: null,
    draftContent: { type: "doc", content: [{ type: "paragraph" }] },
    draftHasText: captured.draftHasText,
    draftHasImages: false,
    handleDocumentChange: () => undefined,
    handleSelectionChange: () => undefined,
  }),
}));
vi.mock("@/hooks/drafts/use-chat-composer-draft-authority", () => ({
  useChatComposerDraftAuthority: () => ({ noteEdit: () => undefined }),
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: false,
  }),
}));
vi.mock("@/hooks/composer/use-composer-paste", () => ({
  isAttachmentIngestPending: () => false,
  useComposerHashPaste: () => ({
    onPaste: () => undefined,
    onDrop: () => undefined,
    onDragOver: () => undefined,
    onDragEnter: () => undefined,
    onDragLeave: () => undefined,
    attachImageFiles: () => undefined,
    dragOverlayVariant: null,
    isIngestingImages: false,
    isResolvingFilePaths: false,
    runPendingImageJob: () => undefined,
  }),
}));
vi.mock("@/hooks/composer/use-composer-pending-image-ingest", () => ({
  useComposerPendingImageIngest: () => ({
    ingestPastedComposerImages: () => undefined,
    reingestPendingImages: () => undefined,
    noteContentImages: () => undefined,
  }),
}));
vi.mock("../use-composer-reingest-on-replacement", () => ({
  useComposerReingestOnReplacement: () => undefined,
}));
vi.mock("../use-provider-reauth-gate", () => ({
  useProviderReauthGate: () => ({
    signedOut: false,
    providerId: null,
    reason: null,
    state: null,
    profileId: null,
    profileLabel: null,
  }),
}));
vi.mock("../use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: false,
    profileLabel: null,
    enablePending: false,
    enableProfile: () => undefined,
  }),
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGateForClient: () => ({
    blocked: captured.packHint !== null,
    hint: captured.packHint,
    preparing: null,
  }),
}));
vi.mock("../use-profile-rate-limit-switch-prompt", () => ({
  useProfileRateLimitSwitchPrompt: () => ({
    kind: "hidden",
    dismiss: () => undefined,
  }),
}));
vi.mock(
  "@/components/chat/fallback/use-settled-routing-card-offers-switch",
  () => ({
    useComposerRateLimitAdvisory: () => null,
  }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));
vi.mock("../use-task-profile-rate-limit-switch", () => ({
  useTaskProfileRateLimitSwitch: () => ({
    affectedChatCount: 0,
    switchOtherTaskChats: () => undefined,
  }),
}));
vi.mock("../use-chat-composer-submit", () => ({
  useChatComposerSubmit: () => ({
    submitDraft: () => undefined,
    steerConflict: {
      open: false,
      onOpenChange: () => undefined,
      onRestart: () => undefined,
      changed: null,
    },
    annotationPreparationPending: false,
  }),
}));

vi.mock("@/components/chat/fallback/chat-composer-fallback-banners", () => ({
  ChatComposerFallbackBanners: () => null,
}));
vi.mock("../chat-composer-banner-portal", () => ({
  ChatComposerBannerPortal: () => null,
}));
vi.mock("../profile-rate-limit-switch-banner", () => ({
  ProfileRateLimitSwitchBanner: () => null,
}));
vi.mock("../profile-disabled-banner", () => ({
  ProfileDisabledBanner: () => null,
}));
vi.mock("../provider-reauth-banner", () => ({
  ProviderReauthBanner: () => null,
}));
vi.mock("../chat-secret-export-notices", () => ({
  ChatSecretExportNotices: () => null,
}));
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskChatGuide: () => null,
}));
vi.mock("../composer-attachment-drop-zone", () => ({
  ComposerAttachmentDropZone: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: (props: { readonly editor: ReactNode }) => props.editor,
}));
vi.mock("@/components/home/composer/composer-workspace-mode-row", () => ({
  ComposerWorkspaceRow: () => null,
}));
vi.mock("../chat-composer-attachments-strip", () => ({
  ChatComposerAttachmentsStrip: () => null,
}));
vi.mock("../chat-composer-editor-slot", () => ({
  ChatComposerEditorSlot: (props: {
    readonly onUserInput?: (wasEmpty: boolean) => void;
  }) => {
    captured.onUserInput = props.onUserInput ?? null;
    return null;
  },
}));
vi.mock("../chat-composer-toolbar-slot", () => ({
  ChatComposerToolbarSlot: () => null,
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

beforeEach(async () => {
  captured.toolbarStore = await createToolbarStore("claude-sonnet");
  captured.mutate.mockClear();
  captured.onUserInput = null;
  captured.support = true;
  captured.paneFocused = true;
  captured.draftHasText = false;
  captured.stagedWorktree = false;
  captured.resting = null;
  captured.agentNotice = null;
  captured.packHint = null;
});

afterEach(() => {
  cleanup();
});

function mountComposer() {
  return render(composerElement());
}

function composerElement() {
  return (
    <ChatComposer
      taskId="chat-1"
      isActive
      sendDisabled={false}
      sendDisabledHint={null}
      mentionRoots={["/repo"]}
      fallbackToGlobalMentionRoots={false}
      currentEpicId="epic-1"
      viewTabId={null}
      settingsSeed={null}
      fallbackSettingsSeed={null}
      providerFallback={NO_PROVIDER_FALLBACK}
      onSubmitMessage={null}
      onSideChat={null}
      onSettingsChange={null}
      activeTurnStatus={null}
      steerCapable={false}
      steerProtocolSupported={false}
      autoPermissionModeProtocolSupported={null}
      getDraftBlobBridgeSupported={() => false}
      getActiveTurnForSteer={() => null}
      editingQueueItemId={null}
      onCancelQueueEdit={null}
      hasPendingApprovals={false}
      stopDisabled={false}
      onStopTurn={null}
      workspaceControls={null}
      workspaceAvailability={{ status: "ready", disabledHint: null }}
      topSpacing="normal"
      topSlot={null}
      suggestedPrompt={undefined}
      restingSandbox={captured.resting}
    />
  );
}

function userInput(wasEmpty: boolean): void {
  act(() => {
    if (captured.onUserInput === null) throw new Error("no editor slot");
    captured.onUserInput(wasEmpty);
  });
}

function pickModel(modelSlug: string): void {
  act(() => {
    captured.toolbarStore?.getState().setSelection({
      harnessId: "claude",
      modelSlug,
      profileId: "profile-a",
    });
  });
}

describe("ChatComposer fires chat.prestartRuntime", () => {
  it("on the first input into an empty draft, with the toolbar's settings", () => {
    mountComposer();

    userInput(true);

    expect(captured.mutate).toHaveBeenCalledTimes(1);
    const request = captured.mutate.mock.calls[0][0];
    expect(request.epicId).toBe("epic-1");
    expect(request.chatId).toBe("chat-1");
    expect(request.settings.harnessId).toBe("claude");
    expect(request.settings.model).toBe("claude-sonnet");
  });

  it("not while the model catalog has not resolved a model: an empty slug never reaches the host", async () => {
    captured.toolbarStore = await createToolbarStore("");
    mountComposer();

    userInput(true);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not on input into a draft that already had content", () => {
    mountComposer();

    userInput(false);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not before any input: mounting with a restored draft or a focused composer fires nothing", () => {
    captured.draftHasText = true;

    mountComposer();

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not when the composer is not focused", () => {
    captured.paneFocused = false;
    mountComposer();

    userInput(true);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not against a host that does not serve the method, nor before support is known", () => {
    captured.support = false;
    const view = mountComposer();
    userInput(true);
    view.unmount();
    captured.support = null;
    mountComposer();
    userInput(true);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not while a worktree is staged for this chat", () => {
    captured.stagedWorktree = true;
    mountComposer();

    userInput(true);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not for a resting sandbox's chat: the tab's host only serves its copy, and the turn runs on the sandbox", () => {
    captured.resting = {
      kind: "resting",
      sandbox: sandboxSummaryFixture({
        id: "sbx-rest",
        hostId: "host-rest",
        state: "suspended",
        displayName: "e2e-sbx-rest",
      }),
      configuration: { kind: "personal" },
      wakeChangesPayer: false,
    };
    mountComposer();

    userInput(true);

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("on a toolbar settings change by the person while the draft is non-empty", () => {
    captured.draftHasText = true;
    mountComposer();

    pickModel("claude-opus");

    expect(captured.mutate).toHaveBeenCalledTimes(1);
    expect(captured.mutate.mock.calls[0][0].settings.model).toBe("claude-opus");
  });

  it("not on a toolbar settings change while the draft is empty", () => {
    mountComposer();

    pickModel("claude-opus");

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("not on settings the app applies (a new seed), even with a non-empty draft", () => {
    captured.draftHasText = true;
    mountComposer();

    act(() => {
      captured.toolbarStore?.getState().applySeed("another-seed", {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "claude-opus",
          profileId: "profile-a",
        },
        reasoning: "medium",
        serviceTier: "",
      });
    });

    expect(captured.mutate).not.toHaveBeenCalled();
  });

  it("a test after the model-picking tests still starts from the default model", () => {
    expect(captured.toolbarStore?.getState()).toBeDefined();
    mountComposer();

    userInput(true);

    expect(captured.mutate.mock.calls[0][0].settings.model).toBe(
      "claude-sonnet",
    );
  });
});

describe("ChatComposer on a sandbox host without Traycer Inference", () => {
  const SENTENCE =
    "Turn on Traycer Inference in Personal's Providers to run agents on sandboxes.";

  function refusal(message: string, onAction: () => void) {
    return {
      kind: "refused" as const,
      message,
      action: { label: "Open Personal's Providers", onAction },
    };
  }

  it("stands the refusal above the composer, with the Providers link", () => {
    const openProviders = vi.fn();
    captured.agentNotice = refusal(SENTENCE, openProviders);
    mountComposer();

    expect(screen.getByTestId("composer-host-notice").textContent).toContain(
      SENTENCE,
    );
    fireEvent.click(screen.getByTestId("composer-host-notice-action"));
    expect(openProviders).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the host holds nothing", () => {
    mountComposer();

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("leaves the pack gate's wait to speak alone while an install is running", () => {
    captured.agentNotice = refusal(SENTENCE, vi.fn());
    captured.packHint = "Installing Codex…";
    mountComposer();

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("stays dismissed for the same refusal and comes back when the refusal changes", () => {
    captured.agentNotice = refusal(SENTENCE, vi.fn());
    const view = mountComposer();

    fireEvent.click(screen.getByTestId("composer-host-notice-dismiss"));
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();

    view.rerender(composerElement());
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();

    captured.agentNotice = refusal(
      "Turn on Traycer Inference in Acme's Providers to run agents on sandboxes.",
      vi.fn(),
    );
    view.rerender(composerElement());
    expect(screen.getByTestId("composer-host-notice").textContent).toContain(
      "in Acme's Providers",
    );
  });
});
