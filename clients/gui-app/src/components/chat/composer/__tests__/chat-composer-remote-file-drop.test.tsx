/**
 * What a dropped or pasted file becomes in the REAL `ChatComposer`, by where the
 * chat runs.
 *
 * A typed path only means something to a chat on this machine. The composer
 * compares the host its turns run on with this renderer's own host id: on this
 * machine the file is typed as a path, as it always was; on any other it goes
 * through the file route the attach button uses (`drafts.putBlob`, kind
 * `file`), and a renderer that knows no local host counts as "another machine".
 *
 * Nothing between the gesture and the document is stubbed: the composer wires
 * `useComposerHashPaste` into the real `ComposerPromptEditor`, whose document is
 * read back through the draft hook's change callback. The editor is seen through
 * a wrapper that forwards to the real one and keeps its handle, so the file can
 * wait for the editor's own `isReady()`. The two things that are answered are
 * the machine's own id and the host client, whose `drafts.putBlob` is the put
 * this file observes.
 */
import {
  fileTransfer,
  pdfFile,
  nodesOfType,
  typedPathSpans,
} from "@/lib/composer/__tests__/file-drop-fixtures";
import {
  forwardRef,
  useCallback,
  type ComponentProps,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  readFileAttachmentUploadStatus,
  type FileAttachmentUploadClient,
} from "@/lib/composer/file-attachment-upload";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import {
  harnessRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { UNUSED_REQUESTER } from "@/lib/composer/__tests__/file-attachment-fixtures";
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
  /** The tab host's client, whose `drafts.putBlob` is observed. */
  client: null as FileAttachmentUploadClient | null,
  /** The last document the editor reported through the draft hook. */
  document: null as JsonContent | null,
  /** The mounted editor's handle, held by the forwarding wrapper below. */
  editorHandle: null as ComposerPromptEditorHandle | null,
}));

const host = vi.hoisted(() => ({
  requestWithOptions: vi.fn<FileAttachmentUploadClient["requestWithOptions"]>(),
}));

const fileDrops = vi.hoisted(() => ({
  resolveDroppedFilePaths:
    vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>(),
  copyDroppedFilePaths:
    vi.fn<(paths: ReadonlyArray<string>) => Promise<string[]>>(),
  readNativeClipboardFilePaths: vi.fn<() => Promise<string[]>>(),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
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
  useTabHostClient: () => answers.client,
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
    handleDocumentChange: (content: JsonContent) => {
      answers.document = content;
    },
    handleSelectionChange: () => undefined,
  }),
}));
vi.mock("@/hooks/drafts/use-chat-composer-draft-authority", () => ({
  useChatComposerDraftAuthority: () => ({ noteEdit: () => undefined }),
}));
// The real editor behind a wrapper that only keeps its handle: whether the
// editor has finished initializing is `isReady()`, which is what a path or file
// insertion asks, and the composer does not hand its ref out.
vi.mock(
  "@/components/chat/composer/composer-prompt-editor",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/composer/composer-prompt-editor")
      >();
    const HandleKeepingEditor = forwardRef<
      ComposerPromptEditorHandle,
      ComponentProps<typeof actual.ComposerPromptEditor>
    >((props, ref) => {
      const keepHandle = useCallback(
        (handle: ComposerPromptEditorHandle | null): void => {
          answers.editorHandle = handle;
          if (typeof ref === "function") ref(handle);
          else if (ref !== null) ref.current = handle;
        },
        [ref],
      );
      return <actual.ComposerPromptEditor {...props} ref={keepHandle} />;
    });
    HandleKeepingEditor.displayName = "HandleKeepingEditor";
    return { ...actual, ComposerPromptEditor: HandleKeepingEditor };
  },
);
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
// The shell's frame and strip are not under test; its editor slot is, and so is
// what the toolbar is told: `attachmentPending` is the composer's own send hold
// (every ingest the paste hook runs, or a file node still unconfirmed), and the
// stand-in toolbar below shows it.
vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: (props: {
    readonly editor: ReactNode;
    readonly toolbar: ReactNode;
  }) => (
    <>
      {props.editor}
      {props.toolbar}
    </>
  ),
}));
vi.mock("@/components/chat/composer/chat-composer-toolbar-slot", () => ({
  ChatComposerToolbarSlot: (props: { readonly attachmentPending: boolean }) => (
    <span
      data-testid="composer-attachment-pending"
      data-busy={String(props.attachmentPending)}
    />
  ),
}));
vi.mock("@/components/chat/segments/steer-settings-conflict-dialog", () => ({
  SteerSettingsConflictDialog: () => null,
}));

import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { ChatComposer } from "@/components/chat/composer/chat-composer";

const REPORT_PATH = "/Users/someone/report.pdf";

const RESTING: RestingChatSandbox = {
  kind: "resting",
  sandbox: sandboxSummaryFixture({
    id: "sbx-1",
    hostId: "sandbox-1",
    state: "suspended",
    displayName: "e2e-sbx",
  }),
  configuration: { kind: "personal" },
  wakeChangesPayer: false,
};

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
  installFreshIndexedDb();
  queryClient = new QueryClient();
  answers.harnesses = [harnessRow("traycer", {})];
  answers.providers = [providerRow("traycer", null)];
  answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
  answers.sandboxes = [];
  answers.tabHostId = "host-local";
  answers.localHostId = null;
  answers.document = null;
  answers.editorHandle = null;
  host.requestWithOptions.mockReset();
  host.requestWithOptions.mockResolvedValue({ ok: true });
  answers.client = {
    ...UNUSED_REQUESTER,
    requestWithOptions: host.requestWithOptions,
  };
  toasts.error.mockClear();
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
});

async function mountComposer(
  restingSandbox: RestingChatSandbox | null,
): Promise<HTMLElement> {
  render(
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>,
  );
  const editor = await screen.findByTestId("composer-editor");
  await waitFor(() => expect(answers.editorHandle?.isReady()).toBe(true));
  return editor;
}

function dropReport(editor: HTMLElement): void {
  fireEvent.drop(editor, {
    dataTransfer: fileTransfer([pdfFile("report.pdf")]),
  });
}

function pasteReport(editor: HTMLElement): void {
  fireEvent.paste(editor, {
    clipboardData: fileTransfer([pdfFile("report.pdf")]),
  });
}

/**
 * Resolves once nothing a gesture started is still running, so that an
 * assertion that something did NOT happen is made when no job is left that
 * could still make it happen: the composer's send hold is released (path
 * resolution, file hashing and image ingest are over), and no file node in the
 * document is still `uploading` (an upload starts once its node is inserted,
 * which is after hashing, and outlives the hold).
 */
async function settled(): Promise<void> {
  await waitFor(() =>
    expect(
      screen
        .getByTestId("composer-attachment-pending")
        .getAttribute("data-busy"),
    ).toBe("false"),
  );
  await waitFor(() => {
    for (const node of nodesOfType(answers.document, "fileAttachment")) {
      const id = node.attrs?.id;
      expect(
        typeof id === "string" && readFileAttachmentUploadStatus(id),
      ).not.toBe("uploading");
    }
  });
}

async function expectUploaded(): Promise<void> {
  await waitFor(() => expect(host.requestWithOptions).toHaveBeenCalledTimes(1));
  const [method, request] = host.requestWithOptions.mock.calls[0];
  expect(method).toBe("drafts.putBlob");
  expect(request).toMatchObject({
    kind: "file",
    fileName: "report.pdf",
    mediaType: "application/pdf",
  });
  await waitFor(() =>
    expect(
      nodesOfType(answers.document, "fileAttachment").map(
        (node) => node.attrs?.fileName,
      ),
    ).toEqual(["report.pdf"]),
  );
  await settled();
  expect(typedPathSpans(answers.document)).toEqual([]);
  expect(toasts.error).not.toHaveBeenCalled();
}

describe("a file dropped or pasted into a regular chat's composer", () => {
  it("is typed as a path when the chat's host is this machine, and nothing is uploaded", async () => {
    answers.localHostId = "host-local";
    const editor = await mountComposer(null);

    dropReport(editor);

    await waitFor(() =>
      expect(typedPathSpans(answers.document)).toEqual([REPORT_PATH]),
    );
    await settled();
    expect(nodesOfType(answers.document, "fileAttachment")).toEqual([]);
    expect(host.requestWithOptions).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("is uploaded as a file attachment when the chat's host is another machine, with no path typed", async () => {
    answers.localHostId = "host-elsewhere";
    const editor = await mountComposer(null);

    dropReport(editor);

    await expectUploaded();
  });

  it("is uploaded when this renderer knows no local host at all", async () => {
    const editor = await mountComposer(null);

    dropReport(editor);

    await expectUploaded();
  });

  it("is uploaded when the chat's tab is on this machine but its sandbox, where its turn runs, is not", async () => {
    answers.localHostId = "host-local";
    const editor = await mountComposer(RESTING);

    dropReport(editor);

    await expectUploaded();
  });

  it("is uploaded when it is pasted rather than dropped, on another machine", async () => {
    answers.localHostId = "host-elsewhere";
    const editor = await mountComposer(null);

    pasteReport(editor);

    await expectUploaded();
  });

  it("is typed as a path when it is pasted on this machine", async () => {
    answers.localHostId = "host-local";
    const editor = await mountComposer(null);

    pasteReport(editor);

    await waitFor(() =>
      expect(typedPathSpans(answers.document)).toEqual([REPORT_PATH]),
    );
    await settled();
    expect(nodesOfType(answers.document, "fileAttachment")).toEqual([]);
    expect(host.requestWithOptions).not.toHaveBeenCalled();
  });
});
