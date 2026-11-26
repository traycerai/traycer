import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { ActivationOutcome } from "@/components/settings/host-scope/use-host-scope";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import {
  userSubscription,
  teamSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { readinessCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";

const HOST_ID = "host-test";
const WORK_PROFILE = "work-profile";
const SURFACE = "landing:window-test";

const host = vi.hoisted(() => ({
  toolbar: null as ComposerToolbarStore | null,
  editContent: null as ComposerBodyProps["onDocumentChange"] | null,
  installEditor: null as (() => void) | null,
  providers: undefined as ReadonlyArray<ProviderCliState> | undefined,
  useRealSend: false,
  sendDisabledHint: null as string | null,
  placementHostId: "host-test",
  poolControlsEnabled: false,
  poolUser: null as AuthenticatedUser | null,
  poolCatalogue: null as SandboxCatalogue | null,
  poolDirectoryEntry: null as HostDirectoryEntry | null,
  poolDirectoryListeners: new Set<() => void>(),
  poolCreateSandbox:
    vi.fn<(input: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>>(),
  poolGetTeamEnvironment:
    vi.fn<(teamId: string) => Promise<TeamEnvironmentFetchResult>>(),
  poolOpenTransport: vi.fn<
    (hostId: string) => {
      readonly close: () => void;
      readonly closeWithReason: (reason: string) => void;
    }
  >(),
  createDispatchHostIds: [] as Array<string | null>,
  activate:
    vi.fn<
      (
        option: HostScopeOption,
        report: (show: () => void) => void,
        current: () => boolean,
      ) => Promise<ActivationOutcome>
    >(),
}));

const createEpic = vi.hoisted(() =>
  vi.fn((_input: unknown): Promise<unknown> => Promise.resolve(undefined)),
);

const PLACEMENT_CLIENT = vi.hoisted(() => ({
  getActiveHostId: () => host.placementHostId,
  // Returning undefined skips the dialable check; the actions hook still calls it.
  getActiveHost: () => undefined,
}));

let releaseCreate = (): void => undefined;

function modelOption(harnessId: GuiHarnessId, slug: string): ModelOption {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const CLAUDE_MODELS = { models: [modelOption("claude", "sonnet-5.5")] };
const CODEX_MODELS = { models: [modelOption("codex", "gpt-6-astra")] };

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const EMPTY_TERMINAL: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "sonnet-5.5",
  permissionMode: "supervised",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => TYPED,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertFileAttachment: () => false,
    settleFileAttachment: () => false,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    draftGeneration: () => 0,
    dismissActiveSuggestion: () => false,
  };
}

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-create-mutation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/epic/use-epic-create-mutation")
  >()),
  useEpicCreateForClient: (
    client: { readonly getActiveHostId: () => string | null } | null,
  ) => ({
    mutateAsync: (request: unknown) => {
      host.createDispatchHostIds.push(client?.getActiveHostId() ?? null);
      return createEpic(request);
    },
    isPending: false,
  }),
}));
vi.mock(
  "@/hooks/epic/use-epic-attach-environment-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/epic/use-epic-attach-environment-mutation")
    >()),
    useEpicAttachmentClient: () => null,
    useEpicAttachEnvironment: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/epic/use-epic-batch-delete-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/epic/use-epic-batch-delete-mutation")
    >()),
    useEpicDiscardCreatedIfEmpty: () => vi.fn(() => Promise.resolve(false)),
  }),
);
vi.mock("@/hooks/agent/use-create-tui-agent", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-create-tui-agent")
  >()),
  useCreateTuiAgentForClient: () => ({
    create: vi.fn(() => Promise.resolve(null)),
    isPending: false,
  }),
}));
vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/harnesses/use-gui-harness-catalog")
    >()),
    useGuiHarnessesQueryForClient: () => ({
      data: {
        harnesses: [
          { id: "claude", available: true },
          { id: "codex", available: false },
        ],
      },
    }),
    useGuiHarnessModelsQueryForClient: (
      _client: unknown,
      harnessId: string,
    ) => ({
      data: harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS,
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: undefined,
    isPending: true,
    isFetching: false,
    fetchStatus: "idle" as const,
    isError: false,
  }),
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));
vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  const { ComposerSendButton } =
    await import("@/components/home/composer/composer-send-button");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      host.toolbar = props.toolbarStore;
      host.editContent = props.onDocumentChange;
      host.sendDisabledHint = props.workspaceDisabledHint;
      host.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      if (host.useRealSend) {
        return React.createElement(ComposerSendButton, {
          canSubmit: props.canSubmit,
          attachmentPending: props.attachmentPending,
          onSubmit: props.onSubmit,
          activeTurnStatus: null,
          stopDisabled: true,
          onStopTurn: null,
          disabledHint: props.workspaceDisabledHint,
        });
      }
      return React.createElement(
        "button",
        {
          type: "button",
          disabled: props.isSubmitting || !props.canSubmit,
          onClick: props.onSubmit,
        },
        "Submit landing",
      );
    },
  };
});
vi.mock("@/hooks/host/use-composer-placement", async () => {
  const { useSurfaceHostSelectionStore } =
    await import("@/stores/host/surface-host-selection-store");
  return {
    useComposerPlacement: () => {
      const selection = useSurfaceHostSelectionStore(
        (state) => state.selections[SURFACE] ?? null,
      );
      const resolvedHostId = selection ?? host.placementHostId;
      const target = {
        resolvedHostId,
        client: PLACEMENT_CLIENT,
        hostLabel: resolvedHostId === HOST_ID ? "Local" : "Acme sandbox",
        isPinned: selection !== null,
        namedHostDead: false,
      };
      return {
        pin: {
          selection,
          setSelection: (hostId: string | null) => {
            host.placementHostId = hostId ?? HOST_ID;
            useSurfaceHostSelectionStore
              .getState()
              .setSelection(SURFACE, hostId);
          },
          resolvedHostId,
          isPinned: selection !== null,
          latchOnFirstUse: () => undefined,
        },
        target,
        submitTarget: target,
        followsEffective: selection === null,
        hostLabelFor: () => target.hostLabel,
      };
    },
  };
});
vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => SURFACE,
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [
          hostScopeOptionFixture({
            hostId: HOST_ID,
            name: "Local",
            isLocalMachine: true,
          }),
        ],
      }),
  };
});
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    signInUrl: "https://billing.test",
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
    },
  }),
}));
vi.mock("@/hooks/composer/use-landing-composer-paste", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/composer/use-landing-composer-paste")
    >();
  return {
    ...actual,
    useLandingComposerPaste: () => ({
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
    }),
  };
});
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
}));
vi.mock("@/components/home/composer/surface-activity-hooks", () => ({
  useSurfaceActivity: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
  useLandingRunWorkingDirectory: () => null,
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGate: () => ({ blocked: false, hint: null, preparing: null }),
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));
vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: false,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
  }),
}));
vi.mock("@/components/chat/composer/provider-reauth-banner", () => ({
  ProviderReauthBanner: () => null,
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-landing-image-fetcher", () => ({
  useLandingImageFetcher: () => vi.fn(),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: host.poolUser,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-catalogue-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-catalogue-query")
    >()),
    useSandboxCatalogue: () => ({
      data: host.poolCatalogue ?? { providers: [] },
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => () => null,
}));
vi.mock("@/hooks/sandboxes/use-team-bundle-balances", () => ({
  useTeamBundleBalances: () => () => 0,
  useReadTeamBundleBalance: () => () => Promise.resolve(null),
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useMakeActiveHost: () => ({
    makeActiveWithWakeNotice: host.activate,
  }),
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => host.poolOpenTransport,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
}));
vi.mock("@/lib/host", () => {
  const directory = {
    getLocalHostId: () => null,
    knownHostIds: () => [],
    refresh: vi.fn(),
    findById: (hostId: string) =>
      host.poolDirectoryEntry?.hostId === hostId
        ? host.poolDirectoryEntry
        : null,
    onChange: (listener: () => void) => {
      host.poolDirectoryListeners.add(listener);
      return {
        dispose: () => host.poolDirectoryListeners.delete(listener),
      };
    },
  };
  const auth = {
    sandboxControlUnavailableReason: () => null,
    environmentCloud: () => ({ onOriginSignIn: () => true }),
    createSandbox: host.poolCreateSandbox,
    getTeamEnvironment: host.poolGetTeamEnvironment,
  };
  const hostClient = {
    createRequesterForHostId: (hostId: string | null) =>
      hostId === null ? null : PLACEMENT_CLIENT,
  };
  return {
    useHostBinding: () =>
      host.poolControlsEnabled ? { auth, directory, hostClient } : null,
    useHostClient: () => null,
    useHostDirectory: () => directory,
    useHostRuntimeClient: () => null,
  };
});
vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));
vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/providers/use-providers-list-query")
    >()),
    useProvidersListForClient: () => {
      if (host.providers === undefined) {
        return {
          status: "pending" as const,
          isStale: false,
          data: undefined,
          isError: false,
          isPending: true,
          isSuccess: false,
          isFetching: false,
          fetchStatus: "idle" as const,
        };
      }
      return {
        status: "success" as const,
        isStale: false,
        data: { providers: host.providers },
        isError: false,
        isPending: false,
        isSuccess: true,
        isFetching: false,
        fetchStatus: "idle" as const,
      };
    },
  }),
);

import { LandingComposer } from "../landing-composer";
import { providerRow } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";

function accountProfile(profileId: string, label: string): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function signedOutClaude(): ProviderCliState {
  return {
    ...providerRow("claude-code", null),
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    profiles: [
      {
        profileId: "terminal-login",
        enabled: true,
        kind: "ambient",
        authType: "oauth",
        label: "Terminal",
        auth: {
          status: "unauthenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
        ambientDriftNotice: null,
        accentColor: null,
      },
      accountProfile(WORK_PROFILE, "Work"),
    ],
  };
}

function toolbar(): ComposerToolbarStore {
  if (host.toolbar === null) throw new Error("the composer did not mount");
  return host.toolbar;
}

function payloadAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      throw new Error(`epic.create payload is missing ${path.join(".")}`);
    }
    if (!Object.hasOwn(current, key)) {
      throw new Error(`epic.create payload is missing ${path.join(".")}`);
    }
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

function payloadProfileId(
  root: unknown,
  path: readonly string[],
): string | null {
  const value = payloadAt(root, path);
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`epic.create payload ${path.join(".")} is not a profile id`);
}

function mountComposer(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui: ReactElement = (
    <LandingComposer
      draftId={null}
      pendingCreateId="pending-draft"
      initialSettings={null}
      workspaceControls={() => null}
    />
  );
  render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

async function submitShownProfile(profileId: string): Promise<unknown> {
  await waitFor(() =>
    expect(toolbar().getState().selection.profileId).toBe(profileId),
  );
  const installEditor = host.installEditor;
  const editContent = host.editContent;
  if (installEditor === null || editContent === null) {
    throw new Error("the composer did not mount");
  }
  act(() => {
    installEditor();
  });
  act(() => {
    editContent(TYPED, { from: 1, to: 1 });
  });
  await waitFor(() => {
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Submit landing",
    });
    expect(button.disabled).toBe(false);
  });
  await userEvent.click(screen.getByRole("button", { name: "Submit landing" }));
  await waitFor(() => expect(createEpic).toHaveBeenCalledTimes(1));
  const request = createEpic.mock.calls[0]?.[0];
  if (request === undefined) throw new Error("epic.create was not called");
  return request;
}

function recordedProfiles(epicId: string): {
  readonly globalProfileId: string | null;
  readonly epicProfileId: string | null;
} {
  const store = useComposerRunSettingsStore.getState();
  const globalLastRun = store.getGlobalRunSettings(HOST_ID);
  const epicLastRun = store.getEpicRunSettings(epicId, HOST_ID);
  if (globalLastRun === null || epicLastRun === null) {
    throw new Error("submit did not record last-run settings");
  }
  return {
    globalProfileId: globalLastRun.profileId,
    epicProfileId: epicLastRun.profileId,
  };
}

beforeEach(() => {
  localStorage.clear();
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore.setState({ selections: {} });
  host.toolbar = null;
  host.editContent = null;
  host.installEditor = null;
  host.providers = [signedOutClaude()];
  host.useRealSend = false;
  host.sendDisabledHint = null;
  host.placementHostId = HOST_ID;
  host.poolControlsEnabled = false;
  host.poolUser = null;
  host.poolCatalogue = null;
  host.poolDirectoryEntry = null;
  host.poolDirectoryListeners.clear();
  host.poolCreateSandbox.mockReset();
  host.poolGetTeamEnvironment.mockReset();
  host.poolOpenTransport.mockReset();
  host.activate.mockReset();
  host.createDispatchHostIds = [];
  releaseCreate = () => undefined;
  createEpic.mockReset();
  createEpic.mockImplementation(
    () =>
      new Promise<{ readonly refusal: { readonly message: string } }>(
        (resolve) => {
          releaseCreate = () => {
            resolve({ refusal: { message: "held" } });
          };
        },
      ),
  );
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerRunSettingsStore
    .getState()
    .setGlobalRunSettings(HOST_ID, EMPTY_TERMINAL, 1);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
    profile: {
      userId: "user-a",
      userName: "user-a",
      email: "user-a@example.com",
    },
  });
});

afterEach(() => {
  releaseCreate();
  cleanup();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    profile: null,
  });
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

describe("a signed-out Terminal login submitted from the landing composer", () => {
  it("runs the first message on the signed-in profile and stores Terminal as last-run", async () => {
    mountComposer();
    const request = await submitShownProfile(WORK_PROFILE);

    expect(
      payloadProfileId(request, [
        "chat",
        "initialMessage",
        "settings",
        "profileId",
      ]),
    ).toBe(WORK_PROFILE);
    const epicId = payloadAt(request, ["epic", "id"]);
    if (typeof epicId !== "string") {
      throw new Error("epic.create did not name an epic");
    }
    expect(recordedProfiles(epicId)).toEqual({
      globalProfileId: null,
      epicProfileId: null,
    });
  });

  it("records the profile in last-run when the person picked it", async () => {
    mountComposer();
    await waitFor(() =>
      expect(toolbar().getState().selection.profileId).toBe(WORK_PROFILE),
    );
    act(() => {
      commitProfileSelection(toolbar(), WORK_PROFILE);
    });

    const request = await submitShownProfile(WORK_PROFILE);
    const epicId = payloadAt(request, ["epic", "id"]);
    if (typeof epicId !== "string") {
      throw new Error("epic.create did not name an epic");
    }
    expect(recordedProfiles(epicId)).toEqual({
      globalProfileId: WORK_PROFILE,
      epicProfileId: WORK_PROFILE,
    });
  });
});

describe("landing task placement from the pool", () => {
  it("pins the Team chooser sandbox and sends the real landing task to its ready host", async () => {
    host.useRealSend = true;
    host.poolControlsEnabled = true;
    host.poolUser = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 100,
      }),
      [teamSubscription(100)],
    );
    host.poolCatalogue = readinessCatalogue({
      warm: 0,
      coldCreateMeasuredMs: 60_000,
    });
    host.poolGetTeamEnvironment.mockResolvedValue({
      kind: "ok",
      environmentId: "team-env",
    });
    const authority = mountTestSelectionAuthority({ hosts: [] });
    host.poolCreateSandbox.mockImplementation(() => {
      host.poolDirectoryEntry = sandboxHostEntry("team-host", {
        id: "team-sandbox",
        name: "Acme",
      });
      authority.publishFleet(
        [{ hostId: "team-host", kind: "sandbox", teamOwned: true }],
        null,
      );
      authority.connectComputer("team-host");
      for (const listener of host.poolDirectoryListeners) listener();
      return Promise.resolve({
        kind: "ok",
        accepted: {
          sandboxId: "team-sandbox",
          hostId: "team-host",
          sandbox: sandboxSummaryFixture({
            id: "team-sandbox",
            hostId: "team-host",
            state: "creating",
            wakeBudgetMs: 60_000,
            environmentId: "team-env",
          }),
        },
      });
    });
    mountComposer();
    const trigger = await screen.findByRole("button", {
      name: "Host: none selected",
    });
    fireEvent.pointerDown(trigger, { button: 0 });
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /New acme sandbox/i }),
    );

    await waitFor(() =>
      expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
        "team-host",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy(),
    );
    expect(host.poolCreateSandbox).toHaveBeenCalledOnce();
    expect(host.poolCreateSandbox.mock.calls[0]?.[0].environmentId).toBe(
      "team-env",
    );
    expect(host.activate).not.toHaveBeenCalled();
    act(() => commitProfileSelection(toolbar(), WORK_PROFILE));

    const installEditor = host.installEditor;
    const editContent = host.editContent;
    if (installEditor === null || editContent === null) {
      throw new Error("the ready landing composer did not mount");
    }
    act(() => installEditor());
    act(() => editContent(TYPED, { from: 1, to: 1 }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Send" })
          .disabled,
      ).toBe(false),
    );
    expect(host.sendDisabledHint).toBeNull();
    createEpic.mockResolvedValue({});
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(createEpic).toHaveBeenCalledOnce());
    expect(host.createDispatchHostIds).toEqual(["team-host"]);
  });
});
