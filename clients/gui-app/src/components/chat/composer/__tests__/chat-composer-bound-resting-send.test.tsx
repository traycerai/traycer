/**
 * A Send on a bound resting sandbox's chat, by the real path: the real
 * `ChatComposer` with its real submit hook, handed the `onSubmitMessage` the
 * tile hands it (`useBoundSandboxSend`, as `chat-tile.tsx` wires it).
 *
 * Faked: the serving host's harness and provider lists, the cloud's
 * `AuthService` (sandbox list, catalogue, Traycer models, the lifecycle verb),
 * the host directory, and the seams around the composer (tile navigation,
 * layout, mention roots, attachment pipeline).
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { AuthService } from "@/lib/auth/auth-service";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { harnessRow } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";

const answers = vi.hoisted(() => ({
  harnesses: [] as ReadonlyArray<GuiHarnessOption>,
  providers: [] as ReadonlyArray<ProviderCliState>,
  /** The cloud catalog's Traycer slugs, `undefined` while unread. */
  cloudTraycerSlugs: undefined as ReadonlyArray<string> | undefined,
  openedTiles: [] as TileOpenIntent[],
  tabHostId: "p3-host",
  binding: null as BoundBinding | null,
  /** What the tile's submit hands to `onSubmitMessage`. */
  submissions: [] as Array<{ readonly model: string; readonly taken: boolean }>,
}));

// The cloud's sandbox list, which names an awake sandbox host's sandbox.
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
// The real runtime, with the cloud (auth) and the host directory replaced by
// the scripted boundary.
vi.mock("@/lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/host")>();
  const overlaid = new WeakMap<object, object>();
  return {
    ...original,
    useHostBinding: () => {
      const real = original.useHostBinding();
      const fake = answers.binding;
      if (real === null || fake === null) return real;
      const seen = overlaid.get(real);
      if (seen !== undefined) return seen;
      const next = { ...real, auth: fake.auth, directory: fake.directory };
      overlaid.set(real, next);
      return next;
    },
  };
});
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

vi.mock("../provider-reauth-banner", () => ({
  ProviderReauthBanner: () => <div data-testid="provider-reauth-banner" />,
}));

// Incidental to the gates: the editor, the draft, the attachment pipeline and
// every surface beside the composer.
vi.mock("@/hooks/chats/use-chat-prestart-runtime", () => ({
  useChatPrestartRuntime: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
  useHostMethodSupport: () => false,
  useHostMethodSchemaVersion: (hostId: string | null, method: string) => {
    if (hostId === null) return null;
    if (method === "epic.create" || method === "epic.createChat")
      return { major: 1, minor: 4 };
    if (method === "epic.updateChatRunSettings") return { major: 1, minor: 2 };
    return null;
  },
}));
vi.mock("../picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ fileDrops: {} }),
  useRunnerHostOrNull: () => null,
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
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskChatGuide: () => null,
}));
vi.mock("../composer-attachment-drop-zone", () => ({
  ComposerAttachmentDropZone: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

import { useCallback } from "react";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { registerChatCloneOpener } from "@/lib/chats/chat-clone-registry";
import { registerActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import {
  bindComposerDraftHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useSandboxDetailsStore } from "@/stores/sandboxes/sandbox-details-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBoundSandboxSend } from "@/hooks/sandboxes/use-bound-sandbox-send";
import {
  createRestingBinding,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import { ChatComposer, type ChatComposerSubmitInput } from "../chat-composer";

interface BoundBinding extends RestingBinding {
  readonly auth: RestingBinding["auth"] & {
    readonly getSandboxCatalogue: Mock<AuthService["getSandboxCatalogue"]>;
  };
}

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

const UNLISTED: ChatRunSettings = {
  ultracode: false,
  harnessId: "traycer",
  model: "trc-retired",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "go" }] }],
};

const REFUSAL_LIST = [
  "Choose a model",
  "Open terminal instead",
  "Choose another host",
  "Cancel the message",
  "Details",
];

function cloudModel(slug: string): GuiAgentModelOption {
  return {
    harnessId: "traycer",
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
  };
}

/** The cloud answers: its sandbox list, its catalogue, and its Traycer models. */
function cloudAnswers(slugs: ReadonlyArray<string> | "unread"): void {
  const binding = answers.binding;
  if (binding === null) throw new Error("no binding");
  binding.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: { sandboxes: [RESTING.sandbox] },
    }),
  );
  binding.auth.getSandboxCatalogue.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      catalogue: { providers: [], offeredAgents: ["traycer"] },
    }),
  );
  binding.auth.getTraycerModels.mockImplementation(() =>
    slugs === "unread"
      ? new Promise(() => undefined)
      : Promise.resolve({ kind: "ok", models: slugs.map(cloudModel) }),
  );
}

/** The tile's wiring of a bound resting sandbox's composer. */
function BoundChat(props: { readonly settings: ChatRunSettings }) {
  const submitBound = useBoundSandboxSend({
    epicId: "epic-1",
    chatId: "chat-p3",
    target: RESTING,
  });
  const onSubmitMessage = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      const taken = submitBound(input);
      answers.submissions.push({ model: input.settings.model, taken });
      return taken;
    },
    [submitBound],
  );
  return (
    <ChatComposer
      taskId="chat-p3"
      isActive
      sendDisabled={false}
      sendDisabledHint={null}
      mentionRoots={[]}
      fallbackToGlobalMentionRoots={false}
      currentEpicId="epic-1"
      viewTabId="tab-1"
      settingsSeed={props.settings}
      fallbackSettingsSeed={null}
      providerFallback={NO_PROVIDER_FALLBACK}
      onSubmitMessage={onSubmitMessage}
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
      restingSandbox={RESTING}
    />
  );
}

let queryClient = new QueryClient();

function mountChat(settings: ChatRunSettings): void {
  render(
    <QueryClientProvider client={queryClient}>
      <HostRuntimeTestProvider>
        <BoundChat settings={settings} />
      </HostRuntimeTestProvider>
    </QueryClientProvider>,
  );
}

function sendButton(): HTMLElement {
  return screen.getByRole("button", { name: "Send" });
}

function noticeButtons(): ReadonlyArray<string | null> {
  return within(screen.getByTestId("composer-host-notice"))
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-label") !== "Dismiss")
    .map((button) => button.textContent);
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  answers.harnesses = [harnessRow("traycer", {}), harnessRow("claude", {})];
  answers.providers = [];
  answers.openedTiles = [];
  answers.submissions = [];
  answers.binding = {
    ...createRestingBinding([]),
    auth: {
      ...createRestingBinding([]).auth,
      getSandboxCatalogue: vi.fn<AuthService["getSandboxCatalogue"]>(),
    },
  };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  useComposerHarnessMemoryStore.getState().resetForTests();
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  // What the composer's draft hook does on mount: the chat's draft row is the
  // tab host's, where a retired draft would be deleted.
  bindComposerDraftHost("chat-p3", "p3-host");
  useComposerDraftStore.getState().replaceDraft("chat-p3", TYPED, null);
});

afterEach(() => {
  cleanup();
  resetDraftMirrorCoordinatorForTests();
  useSandboxDetailsStore.setState({ sandboxId: null });
  useComposerDraftStore.getState().clearDraft("chat-p3");
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

function wakes(): number {
  return answers.binding?.auth.runSandboxVerb.mock.calls.length ?? 0;
}

describe("Send on a bound resting sandbox's chat, with a Traycer model the cloud's list leaves out", () => {
  const LINE =
    "Retired Model doesn't run on this sandbox. Choose another Traycer model to run agents here.";

  it("is refused by a press of Send: the line and bound remedies stand, nothing wakes, the text stays", async () => {
    useComposerHarnessMemoryStore
      .getState()
      .recordModelName("traycer", "trc-retired", "Retired Model");
    cloudAnswers(["trc-listed"]);
    const unregisterClone = registerChatCloneOpener("chat-p3", vi.fn());
    const unregisterPicker = registerActiveModelPicker({
      toggle: vi.fn(),
      openForHarness: vi.fn(),
      getSelectionSummary: () => null,
    });
    onTestFinished(unregisterClone);
    onTestFinished(unregisterPicker);
    mountChat(UNLISTED);
    await screen.findByText(LINE);

    fireEvent.click(sendButton());
    await act(() => Promise.resolve());

    expect(noticeButtons()).toEqual(REFUSAL_LIST);
    expect(wakes()).toBe(0);
    expect(answers.submissions).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
    expect(readComposerDraftSnapshot("chat-p3").content).toEqual(TYPED);
  });

  it("is sent when the list holds the model, as a pending message for the chat's own sandbox", async () => {
    cloudAnswers(["trc-retired"]);
    mountChat(UNLISTED);
    await waitFor(() =>
      expect(sendButton().getAttribute("aria-disabled")).toBeNull(),
    );

    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(answers.submissions).toEqual([
        { model: "trc-retired", taken: true },
      ]),
    );
    const [send, ...rest] = Object.values(
      usePendingSandboxSendStore.getState().sends,
    );
    expect(rest).toEqual([]);
    expect(send.request).toMatchObject({ kind: "message", chatId: "chat-p3" });
    expect(send.settings.model).toBe("trc-retired");
  });

  it.each([
    { state: "unread", slugs: "unread" },
    { state: "listing the model", slugs: ["trc-retired"] },
    { state: "leaving the model out", slugs: ["trc-listed"] },
  ] as const)(
    "never reaches the tile's submit only to be refused there, with the list $state",
    async ({ slugs }) => {
      cloudAnswers(slugs);
      mountChat(UNLISTED);
      await act(() => Promise.resolve());
      await act(() => Promise.resolve());

      fireEvent.click(sendButton());
      await act(() => Promise.resolve());

      // Every submission the composer lets through is one the backstop takes:
      // the gate and the backstop read the same list in the same render.
      expect(answers.submissions.every((submission) => submission.taken)).toBe(
        true,
      );
      expect(wakes()).toBe(0);
    },
  );
});
