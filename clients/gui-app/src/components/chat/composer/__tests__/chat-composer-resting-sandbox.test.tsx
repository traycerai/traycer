/**
 * The composer of a chat whose sandbox rests, drawn by the published copy.
 *
 * That copy is bound to the tab's SERVING host (the person's own machine), not
 * to the sandbox, so every host read here answers for the serving host. The
 * send wakes the sandbox and runs there, so none of those answers may decide
 * it: the pick stays the chat's own, a provider signed out on the serving host
 * never blocks, and an agent sandboxes don't offer is refused from the cloud
 * catalogue before anything is sent.
 *
 * The real `ChatComposer`, toolbar store and run gates; only the host and
 * cloud reads are answered, and the submit hook records what the composer
 * hands it.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  harnessRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";

const answers = vi.hoisted(() => ({
  harnesses: [] as ReadonlyArray<GuiHarnessOption>,
  providers: [] as ReadonlyArray<ProviderCliState>,
  catalogue: undefined as SandboxCatalogue | undefined,
  catalogueFetching: false,
  submit: null as {
    readonly sendDisabled: boolean;
    readonly sendDisabledHint: string | null;
    readonly toolbarStore: ComposerToolbarStore;
  } | null,
}));

function modelOption(harnessId: string, slug: string) {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    isDefault: true,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

// Stable references: a fresh list per render pushes a new catalog each time.
const MODELS: Readonly<Record<string, { readonly models: unknown[] }>> = {
  traycer: { models: [modelOption("traycer", "claude-sonnet-5.5")] },
  codex: { models: [modelOption("codex", "gpt-6.1-sol")] },
  claude: { models: [modelOption("claude", "sonnet")] },
};

// The serving host's own lists - the person's machine, not the sandbox.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: { harnesses: answers.harnesses },
  }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => ({
    data: MODELS[harnessId],
  }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: answers.providers },
  }),
}));
vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: () => ({ data: { providers: answers.providers } }),
}));
// The cloud catalogue: which agents sandboxes run.
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: answers.catalogue,
    isFetching: answers.catalogueFetching,
  }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    supported: true,
    data: { principal: { kind: "personal" } },
    isError: false,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: { environments: [] } }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));
vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProvidersSetProfileEnabledForClient: () => ({ mutate: () => undefined }),
  useProviderProfileEnablementPending: () => () => false,
}));

vi.mock("../use-chat-composer-submit", () => ({
  useChatComposerSubmit: (args: {
    readonly sendDisabled: boolean;
    readonly sendDisabledHint: string | null;
    readonly toolbarStore: ComposerToolbarStore;
  }) => {
    answers.submit = {
      sendDisabled: args.sendDisabled,
      sendDisabledHint: args.sendDisabledHint,
      toolbarStore: args.toolbarStore,
    };
    return {
      submitDraft: () => undefined,
      steerConflict: {
        open: false,
        onOpenChange: () => undefined,
        onRestart: () => undefined,
        changed: null,
      },
      annotationPreparationPending: false,
    };
  },
}));
vi.mock("../provider-reauth-banner", () => ({
  ProviderReauthBanner: () => <div data-testid="provider-reauth-banner" />,
}));

// Incidental to the gates: the editor, the draft, the attachment pipeline and
// every surface beside the composer.
vi.mock("@/hooks/chats/use-chat-prestart-runtime", () => ({
  useChatPrestartRuntime: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => false,
}));
vi.mock("../picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
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
  useTabHostId: () => "serving-host",
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useWorkspaceMentionRoots: () => [],
}));
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useEpicAttachmentBytesPresence: () => null,
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useMaybeEpicStore: () => null,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));
vi.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: () => ({
    initialContent: null,
    initialSelection: null,
    draftContent: { type: "doc", content: [{ type: "paragraph" }] },
    draftHasText: true,
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
vi.mock("../use-profile-rate-limit-switch-prompt", () => ({
  useProfileRateLimitSwitchPrompt: () => ({
    kind: "hidden",
    dismiss: () => undefined,
  }),
}));
vi.mock(
  "@/components/chat/fallback/use-settled-routing-card-offers-switch",
  () => ({ useComposerRateLimitAdvisory: () => null }),
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
vi.mock("@/components/chat/fallback/chat-composer-fallback-banners", () => ({
  ChatComposerFallbackBanners: () => null,
}));
vi.mock("../chat-composer-banner-portal", () => ({
  ChatComposerBannerPortal: () => null,
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
  ComposerShell: () => null,
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { ChatComposer } from "../chat-composer";

const RESTING: RestingChatSandbox = {
  kind: "resting",
  sandbox: sandboxSummaryFixture({
    id: "sbx-p3",
    hostId: "p3-host",
    state: "suspended",
    displayName: "e2e-sbx-p3",
  }),
  configuration: { kind: "personal" },
  wakeChangesPayer: false,
};

const SEEDED_MODEL: Readonly<Record<string, string>> = {
  traycer: "claude-sonnet-5.5",
  codex: "gpt-6.1-sol",
  claude: "sonnet",
};

/** The chat's own settings, as its last turn left them. */
function seed(harnessId: ChatRunSettings["harnessId"]): ChatRunSettings {
  return {
    harnessId,
    model: SEEDED_MODEL[harnessId],
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };
}

const OFFERS_TRAYCER: SandboxCatalogue = {
  providers: [],
  offeredAgents: ["traycer"],
};

function signedOut(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    ...providerRow(providerId, null),
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
  };
}

beforeEach(() => {
  answers.harnesses = [
    harnessRow("traycer", {}),
    harnessRow("claude", {}),
    harnessRow("codex", {}),
  ];
  answers.providers = [];
  answers.catalogue = OFFERS_TRAYCER;
  answers.catalogueFetching = false;
  answers.submit = null;
});

afterEach(() => {
  cleanup();
});

function mountComposer(settings: ChatRunSettings) {
  return render(
    <ChatComposer
      taskId="chat-p3"
      isActive
      sendDisabled={false}
      sendDisabledHint={null}
      mentionRoots={[]}
      fallbackToGlobalMentionRoots={false}
      currentEpicId="epic-1"
      viewTabId="tab-1"
      settingsSeed={settings}
      fallbackSettingsSeed={null}
      providerFallback={NO_PROVIDER_FALLBACK}
      onSubmitMessage={() => true}
      onSideChat={null}
      onSettingsChange={null}
      activeTurnStatus={null}
      steerCapable={false}
      steerProtocolSupported
      autoPermissionModeProtocolSupported={null}
      getDraftBlobBridgeSupported={() => false}
      getActiveTurnForSteer={() => null}
      editingQueueItemId={null}
      onCancelQueueEdit={null}
      hasPendingApprovals={false}
      stopDisabled
      onStopTurn={null}
      workspaceControls={null}
      workspaceAvailability={{ status: "ready", disabledHint: null }}
      topSpacing="normal"
      topSlot={null}
      suggestedPrompt={undefined}
      restingSandbox={RESTING}
    />,
  );
}

function submitted() {
  if (answers.submit === null) throw new Error("the composer never rendered");
  return answers.submit;
}

describe("the composer of a resting sandbox's chat, served by another host", () => {
  it("keeps the chat's Traycer pick when the serving host has Traycer off", () => {
    answers.harnesses = [
      harnessRow("traycer", { available: false }),
      harnessRow("claude", {}),
      harnessRow("codex", {}),
    ];

    mountComposer(seed("traycer"));

    const selection = submitted().toolbarStore.getState().selection;
    expect(selection.harnessId).toBe("traycer");
    expect(selection.modelSlug).toBe("claude-sonnet-5.5");
    expect(submitted().sendDisabled).toBe(false);
  });

  it("refuses an agent sandboxes don't offer at Send, from the catalogue", () => {
    mountComposer(seed("codex"));

    expect(
      screen.getByText(
        "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      ),
    ).toBeTruthy();
    expect(submitted()).toMatchObject({
      sendDisabled: true,
      sendDisabledHint:
        "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
    });
  });

  it("never blocks on a provider signed out on the serving host: the sandbox's own refusal stands", () => {
    answers.providers = [signedOut("claude-code")];

    mountComposer(seed("claude"));

    expect(screen.queryByTestId("provider-reauth-banner")).toBeNull();
    expect(
      screen.getByText(
        "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      ),
    ).toBeTruthy();
  });

  it("holds Send while the catalogue says which agents run on sandboxes", () => {
    answers.catalogue = undefined;
    answers.catalogueFetching = true;

    mountComposer(seed("traycer"));

    expect(
      screen.getByText("Checking which agents run on sandboxes."),
    ).toBeTruthy();
    expect(submitted().sendDisabled).toBe(true);
  });

  it("clears the refusal as soon as the pick moves to an offered agent", () => {
    mountComposer(seed("codex"));
    expect(screen.getByTestId("composer-host-notice")).toBeTruthy();

    act(() => {
      submitted().toolbarStore.getState().setSelection({
        harnessId: "traycer",
        modelSlug: "claude-sonnet-5.5",
        profileId: null,
      });
    });

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    expect(submitted().sendDisabled).toBe(false);
  });
});
