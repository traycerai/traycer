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
 * hands it. The last case is the same chat while its sandbox is awake and
 * serves it: the refusal offers the same remedies.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessId,
  GuiHarnessOption,
  HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  SandboxCatalogue,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
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
  refetchCatalogue: vi.fn(),
  sandboxes: [] as ReadonlyArray<SandboxSummary>,
  /** Whether the tab host answers its model lists; a resting sandbox doesn't. */
  tabHostAnswersModels: true,
  /** The cloud catalog's Traycer models, `undefined` while unread. */
  cloudTraycerModels: undefined as ReadonlyArray<unknown> | undefined,
  openedTiles: [] as TileOpenIntent[],
  tabHostId: "serving-host",
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
    data: answers.tabHostAnswersModels ? MODELS[harnessId] : undefined,
  }),
}));
// The cloud catalog: the Traycer models every sandbox runs.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: answers.cloudTraycerModels }),
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
    refetch: answers.refetchCatalogue,
  }),
}));
// The cloud's sandbox list, which names an awake sandbox host's sandbox.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: { sandboxes: answers.sandboxes },
  }),
}));
// The tile-open seam: the terminal the refusal opens is recorded, not drawn.
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTile: (intent: TileOpenIntent) => {
      answers.openedTiles.push(intent);
      return null;
    },
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
  useTabHostId: () => answers.tabHostId,
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
import { registerChatCloneOpener } from "@/lib/chats/chat-clone-registry";
import { registerActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { queryKeys } from "@/lib/query-keys";
import {
  bindComposerDraftHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  installHostDirectoryRows,
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { useSandboxDetailsStore } from "@/stores/sandboxes/sandbox-details-store";
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

// Stable, like `MODELS`: the cloud lists a model the serving host does not.
const CLOUD_TRAYCER_MODELS: ReadonlyArray<unknown> = [
  {
    ...modelOption("traycer", "claude-sonnet-5.5"),
    label: "Claude Sonnet 5.5",
  },
  { ...modelOption("traycer", "gpt-6.1-sol"), isDefault: false },
];

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

let queryClient = new QueryClient();

beforeEach(() => {
  queryClient = new QueryClient();
  answers.harnesses = [
    harnessRow("traycer", {}),
    harnessRow("claude", {}),
    harnessRow("codex", {}),
  ];
  answers.providers = [];
  answers.catalogue = OFFERS_TRAYCER;
  answers.catalogueFetching = false;
  answers.refetchCatalogue.mockClear();
  answers.sandboxes = [];
  answers.tabHostAnswersModels = true;
  answers.cloudTraycerModels = CLOUD_TRAYCER_MODELS;
  answers.openedTiles = [];
  answers.tabHostId = "serving-host";
  answers.submit = null;
});

afterEach(() => {
  cleanup();
  useSandboxDetailsStore.setState({ sandboxId: null });
  useComposerDraftStore.getState().clearDraft("chat-p3");
  resetHostDirectoryRows();
});

const REFUSAL_LIST = [
  "Choose a model",
  "Open terminal instead",
  "Choose another host",
  "Cancel the message",
  "Details",
];

function noticeButtons(): ReadonlyArray<string | null> {
  return within(screen.getByTestId("composer-host-notice"))
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-label") !== "Dismiss")
    .map((button) => button.textContent);
}

function clickNoticeButton(name: string): void {
  fireEvent.click(
    within(screen.getByTestId("composer-host-notice")).getByRole("button", {
      name,
    }),
  );
}

/** The chat's tile, which can open the chat's clone flow while it is mounted. */
function mountChatTileCloneFlow(): Mock<() => void> {
  const openClone = vi.fn<() => void>();
  const unregister = registerChatCloneOpener("chat-p3", openClone);
  onTestFinished(unregister);
  return openClone;
}

/** The focused composer's picker, which a refusal's Choose a model opens. */
function mountModelPicker(): Mock<
  (harnessId: GuiHarnessId, offeredAgents: ReadonlyArray<string> | null) => void
> {
  const openForHarness =
    vi.fn<
      (
        harnessId: GuiHarnessId,
        offeredAgents: ReadonlyArray<string> | null,
      ) => void
    >();
  const unregister = registerActiveModelPicker({
    toggle: vi.fn(),
    openForHarness,
    getSelectionSummary: () => null,
  });
  onTestFinished(unregister);
  return openForHarness;
}

function mountComposer(settings: ChatRunSettings) {
  return mountComposerOn(settings, RESTING, () => true);
}

function mountComposerWith(
  settings: ChatRunSettings,
  onSubmitMessage: () => boolean,
) {
  return mountComposerOn(settings, RESTING, onSubmitMessage);
}

function mountComposerOn(
  settings: ChatRunSettings,
  restingSandbox: RestingChatSandbox | null,
  onSubmitMessage: () => boolean,
) {
  return render(
    <QueryClientProvider client={queryClient}>
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
        onSubmitMessage={onSubmitMessage}
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
        restingSandbox={restingSandbox}
      />
    </QueryClientProvider>,
  );
}

const TRAYCER_OFF_LINE =
  "Traycer Inference is off on this sandbox, so agents can't run on it.";

/** A providers list with Traycer Inference switched off on that host. */
const TRAYCER_OFF_PROVIDERS: ReadonlyArray<ProviderCliState> = [
  { ...providerRow("traycer", null), enabled: false },
];

/** The resting sandbox's own `providers.list`, as this client last read it. */
const RESTING_PROVIDERS_KEY = queryKeys.hostMethod<
  HostRpcRegistry,
  "providers.list"
>("p3-host", "providers.list", { native: null });

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

  it("refuses with the full list at Send, in order, and Details opens the chat's own sandbox", () => {
    const openClone = mountChatTileCloneFlow();
    mountComposer(seed("codex"));

    expect(noticeButtons()).toEqual(REFUSAL_LIST);
    clickNoticeButton("Details");
    expect(useSandboxDetailsStore.getState().sandboxId).toBe("sbx-p3");
    clickNoticeButton("Choose another host");
    expect(openClone).toHaveBeenCalledOnce();
  });

  it("offers no other host where no tile of the chat can open its clone flow", () => {
    mountComposer(seed("codex"));

    expect(noticeButtons()).not.toContain("Choose another host");
  });

  it("opens a folderless terminal on the chat's own sandbox, in this task's view", () => {
    mountComposer(seed("codex"));

    clickNoticeButton("Open terminal instead");

    expect(answers.openedTiles).toHaveLength(1);
    expect(answers.openedTiles[0]).toMatchObject({
      node: {
        type: "terminal",
        hostId: "p3-host",
        legacyFallback: { cwd: "" },
      },
      target: { tabId: "tab-1" },
      gesture: "explicit",
    });
  });

  it("cancels the message: the refusal closes, nothing is sent, and the text stays in the composer", () => {
    const sent = vi.fn(() => true);
    // What the composer's draft hook does on mount: the chat's draft row is
    // the tab host's, where a retired draft would be deleted.
    bindComposerDraftHost("chat-p3", "serving-host");
    onTestFinished(resetDraftMirrorCoordinatorForTests);
    const typed: JsonContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "go" }] }],
    };
    useComposerDraftStore.getState().replaceDraft("chat-p3", typed, null);
    mountComposerWith(seed("codex"), sent);

    clickNoticeButton("Cancel the message");

    expect(readComposerDraftSnapshot("chat-p3").content).toEqual(typed);
    expect(sent).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    // Still refused: the text waits for a pick the sandbox runs.
    expect(submitted().sendDisabled).toBe(true);
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

  it("holds Send when the catalogue couldn't be read, and Retry reads it again", () => {
    answers.catalogue = undefined;
    answers.catalogueFetching = false;

    mountComposer(seed("codex"));

    expect(
      screen.getByText("Couldn't check which agents run on sandboxes."),
    ).toBeTruthy();
    expect(submitted()).toMatchObject({
      sendDisabled: true,
      sendDisabledHint: "Couldn't check which agents run on sandboxes.",
    });
    fireEvent.click(screen.getByTestId("composer-host-notice-action"));
    expect(answers.refetchCatalogue).toHaveBeenCalledOnce();
  });

  it("lets the pick send when an older server's catalogue names no agents", () => {
    answers.catalogue = { providers: [] };

    mountComposer(seed("codex"));

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    expect(submitted().sendDisabled).toBe(false);
  });

  // Off is refused before anything wakes, whatever the pick, with the full
  // list: Choose a model still opens on what sandboxes run.
  it.each(["traycer", "codex"] as const)(
    "refuses a %s pick before any wake when the sandbox's Traycer Inference was last read off",
    (harnessId) => {
      queryClient.setQueryData(RESTING_PROVIDERS_KEY, {
        providers: TRAYCER_OFF_PROVIDERS,
      });
      mountChatTileCloneFlow();
      const openForHarness = mountModelPicker();
      const sent = vi.fn(() => true);

      mountComposerWith(seed(harnessId), sent);

      expect(screen.getByText(TRAYCER_OFF_LINE)).toBeTruthy();
      expect(noticeButtons()).toEqual(REFUSAL_LIST);
      expect(submitted()).toMatchObject({
        sendDisabled: true,
        sendDisabledHint: TRAYCER_OFF_LINE,
      });
      clickNoticeButton("Choose a model");
      expect(openForHarness).toHaveBeenCalledWith("traycer", ["traycer"]);
      expect(sent).not.toHaveBeenCalled();
    },
  );

  it("lets Traycer send when nothing is known of the sandbox's switch, and asks the sandbox nothing", () => {
    mountComposer(seed("traycer"));

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    expect(submitted().sendDisabled).toBe(false);
    const read = queryClient.getQueryState(RESTING_PROVIDERS_KEY);
    expect(read?.fetchStatus ?? "idle").toBe("idle");
    expect(read?.dataUpdatedAt ?? 0).toBe(0);
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

// A tab opened while the sandbox was awake stays bound to it, so once it rests
// the tab's host is the resting sandbox itself, and it answers no model list.
describe("the composer of a resting sandbox's chat, on a tab bound to that sandbox", () => {
  beforeEach(() => {
    answers.tabHostId = "p3-host";
    answers.tabHostAnswersModels = false;
  });

  it("resolves a Traycer pick with no model to the cloud catalog's default, so Send is open", () => {
    mountComposer({ ...seed("traycer"), model: "" });

    const state = submitted().toolbarStore.getState();
    expect(state.selection).toMatchObject({
      harnessId: "traycer",
      modelSlug: "claude-sonnet-5.5",
    });
    expect(submitted().sendDisabled).toBe(false);
  });

  it("keeps the chat's own Traycer model, labelled from the cloud catalog", () => {
    mountComposer({ ...seed("traycer"), model: "gpt-6.1-sol" });

    const state = submitted().toolbarStore.getState();
    expect(state.selection.modelSlug).toBe("gpt-6.1-sol");
    expect(state.selectedModel?.slug).toBe("gpt-6.1-sol");
    expect(state.sandboxRunTarget).toBe("resting");
  });
});

describe("the composer of an awake sandbox's chat, served by the sandbox", () => {
  it("refuses with the same list, on the tab host's own sandbox", () => {
    answers.tabHostId = "sbx-awake-host";
    answers.sandboxes = [
      sandboxSummaryFixture({ id: "sbx-awake", hostId: "sbx-awake-host" }),
    ];
    installHostDirectoryRows([sandboxHostEntry("sbx-awake-host", null)]);
    mountChatTileCloneFlow();

    mountComposerOn(seed("codex"), null, () => true);

    expect(noticeButtons()).toEqual(REFUSAL_LIST);
    clickNoticeButton("Details");
    expect(useSandboxDetailsStore.getState().sandboxId).toBe("sbx-awake");
    clickNoticeButton("Open terminal instead");
    expect(answers.openedTiles[0]).toMatchObject({
      node: { type: "terminal", hostId: "sbx-awake-host" },
    });
  });

  it("refuses at Send when the sandbox's own providers list shows Traycer off, with the full list", () => {
    answers.tabHostId = "sbx-awake-host";
    answers.sandboxes = [
      sandboxSummaryFixture({ id: "sbx-awake", hostId: "sbx-awake-host" }),
    ];
    answers.harnesses = [harnessRow("traycer", { enabled: false })];
    answers.providers = TRAYCER_OFF_PROVIDERS;
    installHostDirectoryRows([sandboxHostEntry("sbx-awake-host", null)]);
    mountChatTileCloneFlow();
    const openForHarness = mountModelPicker();

    mountComposerOn(seed("traycer"), null, () => true);

    expect(screen.getByText(TRAYCER_OFF_LINE)).toBeTruthy();
    expect(noticeButtons()).toEqual(REFUSAL_LIST);
    expect(submitted()).toMatchObject({
      sendDisabled: true,
      sendDisabledHint: TRAYCER_OFF_LINE,
    });
    clickNoticeButton("Choose a model");
    expect(openForHarness).toHaveBeenCalledWith("traycer", ["traycer"]);
  });
});
