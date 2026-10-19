import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { ChatComposer } from "../chat-composer";

/**
 * The selected toolbar profile reaches the picker hooks THROUGH `ChatComposer`.
 *
 * `useComposerPickerItems` is where the slash popup and the eager known-name
 * map both read their catalog, so a composer that dropped the profile (or kept
 * the previous one) at that call would fetch the wrong account's commands while
 * every hook below it stayed correct. The catalog-hook tests cannot see that
 * call: they pass `profileId` themselves. This mounts the real `ChatComposerImpl`
 * - its own `useStore(toolbarStore, ...)` reads and its own
 * `useComposerPickerItems({...})` call - over a real reactive toolbar store, and
 * records what that call received.
 *
 * Stand-ins, all unrelated to the profile path: the picker hook (it is the
 * capture point), the host/tab/epic/draft/gate hooks and every child surface.
 */

const captured = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly harnessId: string;
    readonly profileId: string | null;
    readonly isActive: boolean;
  }>,
  toolbarStore: null as {
    readonly getState: () => {
      readonly setSelection: (next: {
        readonly harnessId: "claude";
        readonly modelSlug: string;
        readonly profileId: string | null;
      }) => void;
    };
  } | null,
}));

vi.mock("../picker/use-composer-picker-items", () => ({
  useComposerPickerItems: (params: {
    readonly harnessId: string;
    readonly profileId: string | null;
    readonly isActive: boolean;
  }) => {
    captured.calls.push({
      harnessId: params.harnessId,
      profileId: params.profileId,
      isActive: params.isActive,
    });
  },
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "chat-composer-picker-profile-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
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
  captured.toolbarStore = store;
  return { useComposerToolbarStore: () => store };
});

vi.mock("@/lib/layout-overrides", () => ({
  useReadingWidthStyle: () => ({ className: "", maxWidth: "100%" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ fileDrops: {} }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
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
vi.mock("../chat-secret-export-notices", () => ({
  ChatSecretExportNotices: () => null,
}));
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskChatGuide: () => null,
}));
vi.mock("../composer-attachment-drop-zone", () => ({
  ComposerAttachmentDropZone: () => null,
}));
vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: () => null,
}));
vi.mock("@/components/home/composer/composer-workspace-mode-row", () => ({
  ComposerWorkspaceRow: () => null,
}));
vi.mock("../chat-composer-attachments-strip", () => ({
  ChatComposerAttachmentsStrip: () => null,
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

afterEach(() => {
  cleanup();
  captured.calls = [];
});

function mountComposer() {
  return render(
    <ChatComposer
      taskId="chat-1"
      isActive
      sendDisabled={false}
      sendDisabledHint={null}
      mentionRoots={["/repo"]}
      fallbackToGlobalMentionRoots={false}
      currentEpicId={null}
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
    />,
  );
}

describe("ChatComposer forwards the selected toolbar profile to useComposerPickerItems", () => {
  it("passes profile-a on every render, then profile-b after the toolbar selection changes, with harness and activity unchanged", () => {
    mountComposer();

    expect(captured.calls.length).toBeGreaterThan(0);
    expect(
      captured.calls.every(
        (call) =>
          call.profileId === "profile-a" &&
          call.harnessId === "claude" &&
          call.isActive,
      ),
    ).toBe(true);

    act(() => {
      captured.toolbarStore?.getState().setSelection({
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: "profile-b",
      });
    });

    expect(captured.calls.at(-1)).toEqual({
      harnessId: "claude",
      profileId: "profile-b",
      isActive: true,
    });
  });
});
