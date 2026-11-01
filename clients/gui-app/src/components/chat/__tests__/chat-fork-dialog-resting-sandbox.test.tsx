import type { QueryObserverResult } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
/**
 * A fork onto a New sandbox the chat host chip picked is handed to the task.
 *
 * The dialog opens with the sandbox staged; Fork neither creates a chat on the
 * tab's host nor waits there: it moves the stage to a pending send of kind
 * `fork`, which the pending-send driver creates, waits on and delivers.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
  type GuiHarnessId,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useImperativeHandle, type RefObject } from "react";
import type { ChatForkPublicationState } from "../chat-fork-target";

import type { RestingBinding } from "@/hooks/sandboxes/__tests__/resting-directory-fixture";

const TAB_HOST_ID = "tab-host-id";

interface ForkBinding extends RestingBinding {
  readonly hostClient: { readonly createRequesterForHostId: () => null };
}

interface BlockedInput {
  readonly hostId: string | null;
  readonly harnessId: string | null;
}

const dialogMocks = vi.hoisted(() => ({
  binding: null as ForkBinding | null,
  toolbarStore: null as ComposerToolbarStore | null,
  refetchAuthUser:
    vi.fn<
      () => Promise<
        Pick<QueryObserverResult<AuthenticatedUser | null>, "data" | "isError">
      >
    >(),
  createMutate: vi.fn<(input: unknown, options: unknown) => void>(),
  blocked: { current: false },
  blockedInputs: [] as Array<{
    readonly hostId: string | null;
    readonly harnessId: string | null;
  }>,
  clientsByHostId: new Map<string, unknown>(),
  directoryHosts: [] as HostDirectoryEntry[],
  onOpenChange: vi.fn<(open: boolean) => void>(),
  needsOwnHostToast: vi.fn<() => void>(),
  attachCalls: [] as Array<{ epicId: string; teamId: string }>,
  attachAnswers: true,
  /** Each attach asked for, with the callbacks it will answer through. */
  attachRequests: [] as Array<{
    readonly input: { readonly epicId: string; readonly teamId: string };
    readonly onSuccess: () => void;
  }>,
  stagingSeen: [] as Array<unknown>,
  /** The dialog's own host pick, as its workspace controls call it. */
  selectHost: null as ((hostId: string) => void) | null,
  /** Whether the forked harness is available on the selected host. */
  harnessAvailable: true,
  /** What the selected host's model catalog answers: a read that failed has no data. */
  catalog: "loaded" as "loaded" | "failed" | "empty" | "loading",
  /** The model the fork seeds; `""` is no picked model slug. */
  seedModel: "claude-opus-4-7",
  /** The harness's sign-in on the dialog's host. */
  authStatus: "authenticated" as "authenticated" | "unauthenticated",
  offeredAgents: undefined as readonly string[] | undefined,
  openForHarness:
    vi.fn<
      (
        harnessId: GuiHarnessId,
        offeredAgents: ReadonlyArray<string> | null,
      ) => void
    >(),
  publication: { kind: "unknown" } as ChatForkPublicationState,
  publicationReads: [] as Array<{
    readonly enabled: boolean;
    readonly chatId: string | null;
  }>,
  /** The configuration the dialog's host runs. */
  principal: { kind: "personal" } as
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly teamName: string },
  openProviders: vi.fn<() => void>(),
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const { restingDirectory: directory } =
      await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
    return {
      ...(await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >()),
      readHostDirectoryEntry: directory.read,
      subscribeHostRowChanged: directory.subscribe,
    };
  },
);
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null, refetch: dialogMocks.refetchAuthUser }),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [], offeredAgents: dialogMocks.offeredAgents },
    isFetching: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    supported: true,
    data: { principal: dialogMocks.principal },
    isError: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-open-configuration-providers", () => ({
  useConfigurationProvidersOpener: () => () => dialogMocks.openProviders,
}));

vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => ({
  useTeamSandboxHarnessBlocked: (input: BlockedInput): boolean => {
    dialogMocks.blockedInputs.push({
      hostId: input.hostId,
      harnessId: input.harnessId,
    });
    return dialogMocks.blocked.current;
  },
  // The toolbar store's palette controls ask too; the dialog's own Fork gate
  // is what this suite is about.
  useTeamSandboxHarnessGate: () => (): boolean => false,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    mutate: (input: unknown, options: unknown) => {
      dialogMocks.createMutate(input, options);
    },
    isPending: false,
    error: null,
    variables: null,
    reset: () => undefined,
    data: null,
    isError: false,
    isSuccess: false,
    status: "idle",
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return dialogMocks.clientsByHostId.get(hostId) ?? null;
  },
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => dialogMocks.clientsByHostId.get(TAB_HOST_ID) ?? null,
    useHostBinding: () => dialogMocks.binding,
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", async () => {
  const { useMemo } = await import("react");
  const { useRestingDirectoryEntry } =
    await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
  return {
    useHostDirectoryList: () => {
      const entry = useRestingDirectoryEntry(TAB_HOST_ID);
      return { data: useMemo(() => (entry === null ? [] : [entry]), [entry]) };
    },
  };
});

vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: () => null,
}));

vi.mock("@/hooks/chats/use-chat-publication-state-query", () => ({
  useChatPublicationState: (input: {
    readonly enabled: boolean;
    readonly chatId: string | null;
  }): ChatForkPublicationState => {
    dialogMocks.publicationReads.push({
      enabled: input.enabled,
      chatId: input.chatId,
    });
    return input.enabled ? dialogMocks.publication : { kind: "unknown" };
  },
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

// The attachment before a fork onto a team's host: passed straight through,
// so every fork here goes on to `epic.createChat` as it did before.
vi.mock("@/hooks/epic/use-epic-attach-environment-mutation", () => ({
  isAttachEnvironmentUnsupported: () => false,
  toastAttachEnvironmentNeedsOwnHost: dialogMocks.needsOwnHostToast,
  useEpicAttachEnvironment: () => ({
    isPending: false,
    mutate: (
      input: { readonly epicId: string; readonly teamId: string },
      options: { readonly onSuccess: () => void },
    ) => {
      dialogMocks.attachCalls.push(input);
      dialogMocks.attachRequests.push({ input, onSuccess: options.onSuccess });
      if (dialogMocks.attachAnswers) options.onSuccess();
    },
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { readonly method?: string }) => {
    if (args.method === "providers.list") {
      return {
        data: {
          providers: [
            {
              providerId: "claude-code",
              enabled: true,
              disabledBy: null,
              selected: { kind: "bundled" },
              candidates: [],
              auth: {
                status: "authenticated",
                badgeText: null,
                label: null,
                detail: null,
              },
              authPending: false,
              checkedAt: null,
              apiKey: { supported: false, configured: false, source: null },
              terminalAgentArgs: "",
              envOverrides: [],
              loginCapability: null,
              availabilityPending: false,
              nativeCapabilities: {
                supportedTabs: ["general", "env", "usage"],
                mcp: null,
                plugins: null,
                skills: null,
                modelProviders: null,
              },
              managedInstallState: null,
              versionVisibility: null,
              advisory: null,
              profiles: [
                {
                  profileId: "ambient",
                  kind: "ambient",
                  authType: "oauth",
                  label: "Terminal account",
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
                  accentColor: null,
                  ambientDriftNotice: null,
                },
              ],
            },
          ],
        },
      };
    }
    return { data: undefined };
  },
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    readonly store: ComposerToolbarStore;
    readonly openForHarnessRef?: RefObject<
      | ((
          harnessId: GuiHarnessId,
          offeredAgents: ReadonlyArray<string> | null,
        ) => void)
      | null
    >;
  }) => {
    dialogMocks.toolbarStore = props.store;
    useImperativeHandle(
      props.openForHarnessRef ?? null,
      () => dialogMocks.openForHarness,
      [],
    );
    return (
      <button type="button" aria-label="Harness picker">
        Claude Opus
      </button>
    );
  },
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

// The workspace controls are held by their own suites; the dialog's host chip
// and picker are the real ones, fed the staging the dialog built.
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  async () => {
    const { useHostOptions: hostOptions } =
      await import("@/components/settings/host-scope/use-host-options");
    const { useSandboxStaging } =
      await import("@/components/composer/use-sandbox-staging");
    const { WorkspaceHostSwitcher: Switcher } =
      await import("@/components/home/host-workspace-selector/host-section");
    const { NO_HOST_OPTION_REFUSALS: noRefusals } =
      await import("@/components/settings/host-scope/host-option-model");
    return {
      ActiveHostWorkspaceControls: (props: {
        readonly sandboxStaging: SandboxStagingSurface | null;
        readonly hostScope: { readonly hostId: string };
      }) => {
        const { hosts } = hostOptions();
        const staging = useSandboxStaging({
          surface: props.sandboxStaging,
          memoryHostId: props.hostScope.hostId,
          hosts,
          forkOnNew: null,
        });
        return (
          <Switcher
            hosts={hosts}
            activeHostId={props.hostScope.hostId}
            onSelect={() => undefined}
            intent="pin"
            refusalByHostId={noRefusals}
            inertExceptHostId={null}
            disabled={false}
            isLoading={false}
            listsFailed={false}
            onRetryLists={() => undefined}
            composer={staging === null ? null : staging.composer}
            surface="field"
          />
        );
      },
    };
  },
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          enabled: true,
          available: dialogMocks.harnessAvailable,
          error: null,
          authStatus: dialogMocks.authStatus,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    // `undefined` is how the toolbar store learns a catalog has not answered:
    // still loading, or a read that failed.
    data:
      dialogMocks.catalog === "failed" || dialogMocks.catalog === "loading"
        ? undefined
        : {
            models:
              dialogMocks.catalog === "empty"
                ? []
                : [
                    {
                      harnessId: "claude",
                      slug: "claude-opus-4-7",
                      label: "Claude Opus",
                      description: null,
                      contextWindow: null,
                      maxOutputTokens: null,
                      defaultReasoningEffort: null,
                      supportedReasoningEfforts: [],
                      defaultServiceTier: null,
                      supportedServiceTiers: [],
                      metadata: {},
                    },
                  ],
          },
    isError: dialogMocks.catalog === "failed",
    isPending: dialogMocks.catalog === "loading",
  }),
}));

import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import type { SandboxStagingSurface } from "@/components/composer/use-sandbox-staging";
import { useHostPickRequestStore } from "@/stores/composer/host-pick-request-store";
import { sandboxWakeId } from "@/lib/sandboxes/sandbox-wake-wait";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

import {
  useStagedSandboxStore,
  readStagedSandbox,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
} from "@/stores/sandboxes/pending-sandbox-send-store";

function directoryEntry(hostId: string, label: string): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };
}

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = directoryEntry(hostId, hostId);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
    findHostById: (id) => (id === hostId ? entry : null),
  });
  return spine.createRequester(entry);
}

const TAB_HOST_CLIENT = buildHostClient(TAB_HOST_ID);

const SETTINGS_SEED: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-opus-4-7",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const SOURCE_FOLDER = {
  path: "/repo/source",
  name: "source",
  repoIdentifier: null,
  hostId: null,
};

function forkTarget(): ChatForkDialogTarget {
  return {
    sourceChatId: "source-chat",
    sourceChatTitle: "Source chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    parentId: null,
    settingsSeed: { ...SETTINGS_SEED, model: dialogMocks.seedModel },
    workspaceSeed: {
      workspace: {
        folders: [SOURCE_FOLDER.path],
        folderInfoByPath: { [SOURCE_FOLDER.path]: SOURCE_FOLDER },
        primaryPath: SOURCE_FOLDER.path,
      },
      intent: {
        entries: [
          {
            kind: "local",
            workspacePath: SOURCE_FOLDER.path,
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      },
    },
    seedIntentOverride: null,
    carriedInterviews: "settled",
    forkMode: "plain",
    initialHostId: null,
    onlyHostIds: null,
    stagedSandbox: null,
    carriesComposerDraft: false,
  };
}

let queryClient: QueryClient;

function ForkRuntimeTestProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeTestProvider>{props.children}</HostRuntimeTestProvider>
    </QueryClientProvider>
  );
}

function fillTitle(): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Fork agent title" }), {
    target: { value: "Sibling fork" },
  });
}

function forkButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Fork" });
}

const FORK_SURFACE = "chat-fork:epic-test:tab-test";

const NEW_SANDBOX: Extract<StagedSandboxTarget, { kind: "new" }> = {
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
};

function onlyPendingSend(): PendingSandboxSend {
  const sends = Object.values(usePendingSandboxSendStore.getState().sends);
  expect(sends).toHaveLength(1);
  return sends[0];
}

const RESTING_NAME = "Laptop box";

function restingSummary(
  state: "suspended" | "stopped" | "resuming" | "starting" | "awake",
) {
  return sandboxSummaryFixture({
    id: "sbx_rest",
    hostId: TAB_HOST_ID,
    displayName: RESTING_NAME,
    state,
  });
}

/** The tab's host is a sandbox in `state`, in the directory and in the cloud's list. */
function restOn(state: "suspended" | "stopped"): void {
  restingDirectory.setSandbox(TAB_HOST_ID, RESTING_NAME, state);
  dialogMocks.binding?.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: { sandboxes: [restingSummary(state)] },
    }),
  );
}

/** The row as the cloud's list and the directory now carry it. */
function rowIs(
  summary: SandboxSummary,
  directoryState: "suspended" | "stopped" | "resuming" | "starting" | "awake",
  reported: boolean,
): void {
  act(() => {
    queryClient.setQueryData(
      sandboxQueryKeys.list(dialogMocks.binding?.auth ?? {}, "user-a"),
      { sandboxes: [summary] },
    );
    if (directoryState === "awake" && !reported) {
      restingDirectory.setUnreportedSandbox(TAB_HOST_ID, RESTING_NAME);
    } else {
      restingDirectory.setSandbox(TAB_HOST_ID, RESTING_NAME, directoryState);
    }
  });
}

function hostChip(): string {
  return (
    screen.getByRole("button", { name: /^Host:/ }).getAttribute("aria-label") ??
    ""
  );
}

const WOKEN = sandboxSummaryFixture({
  id: "sbx_rest",
  hostId: TAB_HOST_ID,
  displayName: RESTING_NAME,
  state: "awake",
  operation: {
    at: 1_791_000_020_000,
    fromState: "suspended",
    state: "awake",
    cause: "wake",
    outcomeCause: "wake",
    outcomeDetail: null,
    actor: null,
    gesture: null,
  },
});

function renderResting(stagedSandbox: ChatForkDialogTarget["stagedSandbox"]) {
  return render(
    <ChatForkDialog
      open
      target={{ ...forkTarget(), stagedSandbox }}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={dialogMocks.onOpenChange}
    />,
    { wrapper: ForkRuntimeTestProvider },
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  dialogMocks.createMutate.mockReset();
  dialogMocks.refetchAuthUser.mockReset();
  dialogMocks.refetchAuthUser.mockResolvedValue({ data: null, isError: false });
  dialogMocks.onOpenChange.mockReset();
  dialogMocks.stagingSeen.length = 0;
  dialogMocks.harnessAvailable = true;
  dialogMocks.catalog = "loaded";
  dialogMocks.seedModel = "claude-opus-4-7";
  dialogMocks.offeredAgents = undefined;
  dialogMocks.publication = { kind: "covered" };
  dialogMocks.clientsByHostId.clear();
  dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
  dialogMocks.binding = {
    ...createRestingBinding([]),
    directory: {
      ...createRestingBinding([]).directory,
      selectById: vi.fn(),
      getLocalEntry: () => null,
    },
    hostClient: { createRequesterForHostId: () => null },
  } as ForkBinding;
  restingDirectory.clear();
  useWorktreeIntentStagingStore.getState().resetForTests();
  useSeededWorkspaceSnapshotStore.getState().resetForTests();
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useHostPickRequestStore.setState({ bySurface: {} });
  useSandboxWakeReportStore.setState({ answeredWakes: {} });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
});

afterEach(() => {
  useAuthStore.getState().setSignedOut();
  restingDirectory.clear();
  resetNegotiatedManifests();
  cleanup();
});

describe("a fork dialog on a tab whose host is a sandbox that rests", () => {
  it.each([
    { state: "suspended", verb: "resume" },
    { state: "stopped", verb: "start" },
  ] as const)(
    "stages the $state sandbox it finds no stage for, and Fork hands the wake over",
    async ({ state, verb }) => {
      restOn(state);
      renderResting(null);
      await waitFor(() =>
        expect(readStagedSandbox(FORK_SURFACE)?.target).toMatchObject({
          kind: "existing",
          hostId: TAB_HOST_ID,
          sandboxId: "sbx_rest",
          verb,
        }),
      );
      fillTitle();

      fireEvent.click(forkButton());

      await waitFor(() => {
        expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
      });
      expect(dialogMocks.createMutate).not.toHaveBeenCalled();
      const send = onlyPendingSend();
      expect(send.request.kind).toBe("fork");
      expect(
        readStagedSandbox(pendingSendSurfaceKey(send.id))?.target,
      ).toMatchObject({ hostId: TAB_HOST_ID, sandboxId: "sbx_rest", verb });
    },
  );

  it("leaves the pick the chip staged where it is, and stages nothing over it", async () => {
    restOn("suspended");
    // The sandbox list is already read, so the resting stage could land on mount.
    queryClient.setQueryData(
      sandboxQueryKeys.list(dialogMocks.binding?.auth ?? {}, "user-a"),
      { sandboxes: [restingSummary("suspended")] },
    );
    renderResting(NEW_SANDBOX);
    await waitFor(() =>
      expect(readStagedSandbox(FORK_SURFACE)?.target).toEqual(NEW_SANDBOX),
    );
    await act(() => Promise.resolve());

    expect(readStagedSandbox(FORK_SURFACE)?.target).toEqual(NEW_SANDBOX);
  });

  describe("as the wake passes through awake with a host that has not reported", () => {
    async function wakeUnreported(): Promise<void> {
      restOn("suspended");
      renderResting(null);
      await waitFor(() =>
        expect(readStagedSandbox(FORK_SURFACE)).not.toBeNull(),
      );
      expect(hostChip()).toBe("Host: Laptop box · suspended, resumes on send");
      rowIs(restingSummary("resuming"), "resuming", false);
      rowIs(WOKEN, "awake", false);
    }

    it("reads resuming on the chip, never offline, with the stage held", async () => {
      await wakeUnreported();

      expect(hostChip()).toBe("Host: Laptop box resuming");
      expect(readStagedSandbox(FORK_SURFACE)?.target).toMatchObject({
        hostId: TAB_HOST_ID,
      });
    });

    it("reads resuming in the picker and never says the sandbox is offline", async () => {
      await wakeUnreported();

      fireEvent.click(screen.getByRole("button", { name: /^Host:/ }));
      await screen.findByText("Manage sandboxes in Settings");

      fireEvent.click(screen.getByText(/Sandboxes you started/));
      const row = Array.from(document.querySelectorAll("[role]")).find(
        (element) => element.textContent.startsWith("SandboxLaptop box"),
      );
      expect(row?.textContent).toContain("Laptop boxresuming");
      expect(document.body.textContent).not.toMatch(/offline/i);
    });

    it("reads awake once the host has reported, and lets the stage go", async () => {
      await wakeUnreported();

      act(() =>
        useSandboxWakeReportStore
          .getState()
          .recordAnswer("sbx_rest", sandboxWakeId(WOKEN)),
      );

      await waitFor(() => expect(readStagedSandbox(FORK_SURFACE)).toBeNull());
      expect(hostChip()).toBe("Host: Laptop box, awake");
    });
  });

  describe("when Fork is refused for an agent the sandbox does not offer", () => {
    async function refuse(
      stagedSandbox: ChatForkDialogTarget["stagedSandbox"],
      hostState: "suspended" | "awake",
    ): Promise<HTMLElement> {
      dialogMocks.offeredAgents = ["traycer"];
      restOn("suspended");
      if (hostState === "awake")
        restingDirectory.setSandbox(TAB_HOST_ID, RESTING_NAME, "awake");
      renderResting(stagedSandbox);
      await waitFor(() =>
        expect(readStagedSandbox(FORK_SURFACE)).not.toBeNull(),
      );
      fillTitle();
      fireEvent.click(forkButton());
      return screen.findByRole("alert");
    }

    it("offers another host, which opens the host picker and keeps the stage", async () => {
      const notice = await refuse(null, "suspended");
      const staged = readStagedSandbox(FORK_SURFACE);
      expect(
        within(notice).queryByRole("button", { name: /^Use Laptop box/ }),
      ).toBeNull();

      fireEvent.click(
        within(notice).getByRole("button", { name: "Use another host" }),
      );

      expect(
        await screen.findByText("Manage sandboxes in Settings"),
      ).toBeDefined();
      expect(useHostPickRequestStore.getState().bySurface[FORK_SURFACE]).toBe(
        1,
      );
      expect(readStagedSandbox(FORK_SURFACE)).toBe(staged);
    });

    it("names the dialog's host and takes the stage off when the stage is on another", async () => {
      const notice = await refuse(NEW_SANDBOX, "awake");

      fireEvent.click(
        within(notice).getByRole("button", { name: /^Use Laptop box/ }),
      );

      expect(readStagedSandbox(FORK_SURFACE)).toBeNull();
      expect(
        useHostPickRequestStore.getState().bySurface[FORK_SURFACE],
      ).toBeUndefined();
    });
  });
});
