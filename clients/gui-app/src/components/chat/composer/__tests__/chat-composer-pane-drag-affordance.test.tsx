/**
 * The drag affordance of a chat pane, through the REAL `ChatComposer` and its
 * real editor inside a pane that is one drop zone (T386): a file dragover that
 * arrives with no dragenter shows the pane's overlay, a dragover on the editor
 * and then on the rest of the pane keeps it, and one outside the pane, or a drop,
 * ends it. The composer's collaborators are answered as in
 * `chat-composer-remote-file-drop.test.tsx`.
 */
import {
  fileTransfer,
  type FakeTransfer,
  pdfFile,
} from "@/lib/composer/__tests__/file-drop-fixtures";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  SandboxCatalogue,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import {
  harnessRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

const answers = vi.hoisted(() => ({
  harnesses: [] as ReadonlyArray<GuiHarnessOption>,
  providers: [] as ReadonlyArray<ProviderCliState>,
  catalogue: undefined as SandboxCatalogue | undefined,
  sandboxes: [] as ReadonlyArray<SandboxSummary>,
  /** The host the chat's tab is bound to. */
  tabHostId: "host-local",
  /** This renderer's own host id; `null` where it knows no local host. */
  localHostId: null as string | null,
}));

const fileDrops = vi.hoisted(() => ({
  resolveDroppedFilePaths:
    vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>(),
  copyDroppedFilePaths:
    vi.fn<(paths: ReadonlyArray<string>) => Promise<string[]>>(),
  readNativeClipboardFilePaths: vi.fn<() => Promise<string[]>>(),
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
};

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: { harnesses: answers.harnesses },
  }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => ({
    data: MODELS[harnessId],
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: answers.providers },
  }),
}));
vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: () => ({ data: { providers: answers.providers } }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: answers.catalogue,
    isFetching: false,
    refetch: () => undefined,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: { sandboxes: answers.sandboxes },
  }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: () => null }),
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
vi.mock("@/components/chat/composer/use-chat-composer-submit", () => ({
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
vi.mock("@/components/chat/composer/provider-reauth-banner", () => ({
  ProviderReauthBanner: () => null,
}));
vi.mock("@/hooks/chats/use-chat-prestart-runtime", () => ({
  useChatPrestartRuntime: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => false,
  useHostMethodSchemaVersion: (hostId: string | null, method: string) => {
    if (hostId === null) return null;
    if (method === "epic.create" || method === "epic.createChat")
      return { major: 1, minor: 4 };
    if (method === "epic.updateChatRunSettings") return { major: 1, minor: 2 };
    return null;
  },
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/lib/layout-overrides", () => ({
  useReadingWidthStyle: () => ({ className: "", maxWidth: "100%" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ fileDrops }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => answers.tabHostId,
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => answers.localHostId,
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

const EMPTY_DOCUMENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

// The document the editor reports is the one thing read back from the draft;
// the draft store, mirror and host are not what this file is about.
vi.mock("@/components/chat/composer/use-chat-composer-draft", () => ({
  useChatComposerDraft: () => ({
    initialContent: EMPTY_DOCUMENT,
    initialSelection: null,
    draftContent: EMPTY_DOCUMENT,
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
vi.mock("@/hooks/composer/use-composer-pending-image-ingest", () => ({
  useComposerPendingImageIngest: () => ({
    ingestPastedComposerImages: () => undefined,
    reingestPendingImages: () => undefined,
    noteContentImages: () => undefined,
  }),
}));
vi.mock(
  "@/components/chat/composer/use-composer-reingest-on-replacement",
  () => ({
    useComposerReingestOnReplacement: () => undefined,
  }),
);
vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: () => undefined,
    }),
  }),
);
vi.mock(
  "@/components/chat/fallback/use-settled-routing-card-offers-switch",
  () => ({ useComposerRateLimitAdvisory: () => null }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));
vi.mock(
  "@/components/chat/composer/use-task-profile-rate-limit-switch",
  () => ({
    useTaskProfileRateLimitSwitch: () => ({
      affectedChatCount: 0,
      switchOtherTaskChats: () => undefined,
    }),
  }),
);
vi.mock("@/components/chat/fallback/chat-composer-fallback-banners", () => ({
  ChatComposerFallbackBanners: () => null,
}));
vi.mock("@/components/chat/composer/chat-composer-banner-portal", () => ({
  ChatComposerBannerPortal: () => null,
}));
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskChatGuide: () => null,
}));
vi.mock("@/components/chat/composer/composer-attachment-drop-zone", () => ({
  ComposerAttachmentDropZone: (props: { readonly children: ReactNode }) =>
    props.children,
}));
// The shell's frame and strip are not under test; its editor slot is.
vi.mock(
  "@/components/home/composer/composer-shell",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/home/composer/composer-shell")
    >()),
    ComposerShell: (props: {
      readonly editor: ReactNode;
      readonly toolbar: ReactNode;
    }) => (
      <>
        {props.editor}
        {props.toolbar}
      </>
    ),
  }),
);
vi.mock("@/components/chat/composer/chat-composer-toolbar-slot", () => ({
  ChatComposerToolbarSlot: () => null,
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

import { useComposerDropScope } from "@/components/chat/composer/composer-drop-scope";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { ChatComposer } from "@/components/chat/composer/chat-composer";

const REPORT_PATH = "/Users/someone/report.pdf";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "traycer",
  model: "claude-sonnet-5.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

let queryClient = new QueryClient();

beforeEach(() => {
  vi.useFakeTimers();
  installFreshIndexedDb();
  queryClient = new QueryClient();
  answers.harnesses = [harnessRow("traycer", {})];
  answers.providers = [providerRow("traycer", null)];
  answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
  answers.sandboxes = [];
  answers.tabHostId = "host-local";
  answers.localHostId = null;
  fileDrops.resolveDroppedFilePaths.mockReset();
  fileDrops.resolveDroppedFilePaths.mockResolvedValue([REPORT_PATH]);
  fileDrops.copyDroppedFilePaths.mockReset();
  fileDrops.copyDroppedFilePaths.mockImplementation((paths) =>
    Promise.resolve([...paths]),
  );
  fileDrops.readNativeClipboardFilePaths.mockReset();
  fileDrops.readNativeClipboardFilePaths.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function composerElement(restingSandbox: RestingChatSandbox | null) {
  return (
    <ChatComposer
      taskId="chat-remote-drop"
      isActive
      sendDisabled={false}
      sendDisabledHint={null}
      mentionRoots={[]}
      runWorkingDirectory={null}
      fallbackToGlobalMentionRoots={false}
      currentEpicId="epic-1"
      viewTabId="tab-1"
      settingsSeed={SETTINGS}
      fallbackSettingsSeed={null}
      providerFallback={NO_PROVIDER_FALLBACK}
      onSubmitMessage={() => true}
      onSideChat={null}
      onSettingsChange={null}
      activeTurnStatus={null}
      steerCapable={false}
      steerProtocolSupported
      autoPermissionModeProtocolSupported={null}
      ultracodeProtocolSupported={false}
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
  );
}

/** A pane that is one drop zone for the composer inside it, with a transcript beside it. */
function DropPane(props: { readonly children: ReactNode }) {
  const scope = useComposerDropScope();
  return (
    <div data-testid="pane" className="relative" {...scope.zoneProps}>
      <div data-testid="transcript" />
      {scope.provide(props.children)}
      {scope.overlay}
    </div>
  );
}

const OVERLAY_TITLES = Object.values(FILE_DROP_OVERLAY_CONTENT).map(
  (content) => content.title,
);

interface ReportDrag extends FakeTransfer {
  dropEffect: string;
}

function report(): ReportDrag {
  return { ...fileTransfer([pdfFile("report.pdf")]), dropEffect: "none" };
}

/**
 * The composer's editor, once the fake clock has let it mount. The 40
 * advances of 50 ms are a fail-only guard: they end a test whose editor never
 * mounts with a named error, and decide no pass.
 */
async function mountedEditor(): Promise<HTMLElement> {
  for (let step = 0; step < 40; step += 1) {
    const editor = screen.queryByTestId("composer-editor");
    if (editor !== null) return editor;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }
  throw new Error("the composer's editor did not mount");
}

/**
 * Runs the pending timers until none is left. The editor's own one-shot timers
 * (prosemirror-view's 20 ms selection check and `DOMObserver` flush, TipTap's
 * 1 ms `scheduleDestroy` and its 0 ms core timer) run out in two runs; zero
 * left means nothing scheduled can raise the overlay afterwards. The five runs
 * are a fail-only guard: only the count reaching zero decides a pass.
 */
async function runTimersUntilQuiet(): Promise<void> {
  for (let run = 1; run <= 5; run += 1) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    if (vi.getTimerCount() === 0) return;
  }
  throw new Error(`${String(vi.getTimerCount())} timers are still pending`);
}

function overlayShown(): boolean {
  return OVERLAY_TITLES.some(
    (title) => screen.queryAllByText(title).length > 0,
  );
}

function dragOverOn(target: Element): void {
  fireEvent.dragOver(target, { dataTransfer: report() });
}

describe("the agent composer's pane as a drag affordance", () => {
  it("shows the overlay for a file dragover that arrives with no dragenter", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DropPane>{composerElement(null)}</DropPane>
      </QueryClientProvider>,
    );
    await mountedEditor();
    await runTimersUntilQuiet();

    dragOverOn(screen.getByTestId("transcript"));

    expect(overlayShown()).toBe(true);
  });

  it("keeps the overlay when the drag moves from the editor to the rest of the pane", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DropPane>{composerElement(null)}</DropPane>
      </QueryClientProvider>,
    );
    const editor = await mountedEditor();
    await runTimersUntilQuiet();
    dragOverOn(screen.getByTestId("transcript"));

    dragOverOn(editor);
    dragOverOn(screen.getByTestId("transcript"));

    expect(overlayShown()).toBe(true);
  });

  it("ends the overlay for a dragover outside the pane, and for a drop", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DropPane>{composerElement(null)}</DropPane>
        <div data-testid="outside" />
      </QueryClientProvider>,
    );
    await mountedEditor();
    await runTimersUntilQuiet();
    dragOverOn(screen.getByTestId("transcript"));
    expect(overlayShown()).toBe(true);

    dragOverOn(screen.getByTestId("outside"));
    await runTimersUntilQuiet();
    expect(overlayShown()).toBe(false);

    dragOverOn(screen.getByTestId("transcript"));
    expect(overlayShown()).toBe(true);
    fireEvent.drop(screen.getByTestId("transcript"), {
      dataTransfer: report(),
    });
    await runTimersUntilQuiet();
    expect(overlayShown()).toBe(false);
  });

  it("stays idle for a plain-text drag", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DropPane>{composerElement(null)}</DropPane>
      </QueryClientProvider>,
    );
    await mountedEditor();
    await runTimersUntilQuiet();

    fireEvent.dragOver(screen.getByTestId("transcript"), {
      dataTransfer: {
        files: [],
        types: ["text/plain"],
        items: [],
        getData: () => "words",
        dropEffect: "none",
      },
    });

    await runTimersUntilQuiet();
    expect(overlayShown()).toBe(false);
  });
});
