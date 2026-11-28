import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { ChatComposer } from "../chat-composer";

/**
 * The editing pill's note, through the REAL `ChatComposer` and the real pill.
 *
 * A save-and-steer that changes the queued message's folders only saves, and
 * the pill says so - but only while a Mod-Enter would otherwise have steered.
 *
 * Stand-ins, all unrelated to the note: the host/tab/epic/draft/gate hooks and
 * every child surface other than the pill's strip.
 */

const captured = vi.hoisted(() => ({
  toolbarStore: null as ComposerToolbarStore | null,
}));

// A chat composer on a sandbox host refuses an unrunnable agent at Send;
// nothing in this suite sits on one, nor on a resting sandbox's chat.
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
  useRestingSandboxAgentGate: () => ({
    blocked: false,
    hint: null,
    notice: null,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: { sandboxes: [] } }),
}));

vi.mock("@/hooks/chats/use-chat-prestart-runtime", () => ({
  useChatPrestartRuntime: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) =>
    method === "epic.updateChatRunSettings" ? { major: 1, minor: 2 } : null,
}));
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
      ultracode: false,
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
    ultracodeCarried: false,
    hostId: null,
  });
}

vi.mock("@/lib/layout-overrides", () => ({
  useReadingWidthStyle: () => ({ className: "", maxWidth: "100%" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ fileDrops: {} }),
  useRunnerHostOrNull: () => null,
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
  usePaneFocused: () => true,
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
    draftHasText: false,
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
vi.mock("@/hooks/composer/use-composer-paste", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/composer/use-composer-paste")
  >()),
  isAttachmentIngestPending: () => false,
  useComposerHashPaste: () => ({
    onPaste: () => undefined,
    onDrop: () => undefined,
    onDragOver: () => undefined,
    onDragEnter: () => undefined,
    onDragLeave: () => undefined,
    attachImageFiles: () => undefined,
    attachFiles: () => undefined,
    dragOverlayVariant: null,
    isIngestingImages: false,
    isResolvingFilePaths: false,
    isAttachingFiles: false,
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
    blocked: false,
    hint: null,
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
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskChatGuide: () => null,
}));
vi.mock("../composer-attachment-drop-zone", () => ({
  ComposerAttachmentDropZone: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: (props: {
    readonly attachmentsStrip: ReactNode;
    readonly editor: ReactNode;
  }) => (
    <>
      {props.attachmentsStrip}
      {props.editor}
    </>
  ),
}));
vi.mock("@/components/home/composer/composer-workspace-mode-row", () => ({
  ComposerWorkspaceRow: () => null,
}));
vi.mock("../chat-composer-editor-slot", () => ({
  ChatComposerEditorSlot: () => null,
}));
vi.mock("../chat-composer-toolbar-slot", () => ({
  ChatComposerToolbarSlot: () => null,
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

beforeEach(async () => {
  captured.toolbarStore = await createToolbarStore("claude-sonnet");
  useSettingsStore.setState({ steerOnModEnterEnabled: true });
});

afterEach(() => {
  cleanup();
});

// The composer's file put is a mutation, so it needs a query client; one per
// test, kept across a test's rerenders.
let queryClient = new QueryClient();
beforeEach(() => {
  queryClient = new QueryClient();
});

function mountEditingComposer(input: {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly changesWorkspace: boolean;
  readonly foldersBlocked: boolean;
}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatComposer
        taskId="chat-1"
        isActive
        sendDisabled={false}
        sendDisabledHint={null}
        mentionRoots={["/repo"]}
        runWorkingDirectory={null}
        fallbackToGlobalMentionRoots={false}
        currentEpicId="epic-1"
        viewTabId={null}
        settingsSeed={null}
        fallbackSettingsSeed={null}
        providerFallback={NO_PROVIDER_FALLBACK}
        onSubmitMessage={null}
        onSideChat={null}
        onSettingsChange={null}
        activeTurnStatus={input.activeTurnStatus}
        steerCapable
        steerProtocolSupported
        autoPermissionModeProtocolSupported={null}
        ultracodeProtocolSupported={false}
        getDraftBlobBridgeSupported={() => false}
        getActiveTurnForSteer={() => null}
        editingQueueItemId="queue-item-1"
        onCancelQueueEdit={() => undefined}
        queueEditChangesWorkspace={input.changesWorkspace}
        queueEditFoldersBlocked={input.foldersBlocked}
        hasPendingApprovals={false}
        stopDisabled={false}
        onStopTurn={null}
        workspaceControls={null}
        workspaceAvailability={{ status: "ready", disabledHint: null }}
        topSpacing="normal"
        topSlot={null}
        suggestedPrompt={undefined}
        restingSandbox={null}
      />
    </QueryClientProvider>,
  );
}

const NOTE = "Can't steer: folders changed";

describe("the editing pill's steer-off note", () => {
  it("says folders changed while a turn is running and a Mod-Enter would steer", () => {
    mountEditingComposer({
      activeTurnStatus: "running",
      changesWorkspace: true,
      foldersBlocked: false,
    });

    expect(screen.getByTestId("queue-edit-draft-note").textContent).toBe(NOTE);
  });

  it("is absent when the edit changes no folders", () => {
    mountEditingComposer({
      activeTurnStatus: "running",
      changesWorkspace: false,
      foldersBlocked: false,
    });

    expect(screen.getByTestId("queue-edit-draft-pill")).toBeDefined();
    expect(screen.queryByTestId("queue-edit-draft-note")).toBeNull();
  });

  it("is absent when no turn is running, since nothing would steer", () => {
    mountEditingComposer({
      activeTurnStatus: null,
      changesWorkspace: true,
      foldersBlocked: false,
    });

    expect(screen.getByTestId("queue-edit-draft-pill")).toBeDefined();
    expect(screen.queryByTestId("queue-edit-draft-note")).toBeNull();
  });

  it("is absent when the person turned steering off", () => {
    useSettingsStore.setState({ steerOnModEnterEnabled: false });
    mountEditingComposer({
      activeTurnStatus: "running",
      changesWorkspace: true,
      foldersBlocked: false,
    });

    expect(screen.queryByTestId("queue-edit-draft-note")).toBeNull();
  });

  it("says the host must be updated, whatever the turn, when the folders cannot be saved", () => {
    mountEditingComposer({
      activeTurnStatus: null,
      changesWorkspace: false,
      foldersBlocked: true,
    });

    expect(screen.getByTestId("queue-edit-draft-note").textContent).toBe(
      "Update this host to change a queued message's folders.",
    );
  });
});
