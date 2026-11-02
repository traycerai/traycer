import type { QueryObserverResult } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
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
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useImperativeHandle, type RefObject } from "react";
import type { ChatForkPublicationState } from "../chat-fork-target";

const TAB_HOST_ID = "tab-host-id";
const OLD_HOST_ID = "old-host-id";

interface BlockedInput {
  readonly hostId: string | null;
  readonly harnessId: string | null;
}

const dialogMocks = vi.hoisted(() => ({
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
    useHostBinding: () => ({
      directory: { selectById: vi.fn() },
    }),
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: dialogMocks.directoryHosts }),
}));

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

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: (props: {
      readonly sandboxStaging: unknown;
      readonly hostScope: { readonly onSelect?: (hostId: string) => void };
    }) => {
      dialogMocks.stagingSeen.push(props.sandboxStaging);
      dialogMocks.selectHost = props.hostScope.onSelect ?? null;
      return <div data-testid="fork-workspace" />;
    },
  }),
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

import {
  installHostDirectoryRows,
  plainHostEntry,
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
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

function ForkRuntimeTestProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <HostRuntimeTestProvider>{props.children}</HostRuntimeTestProvider>
    </QueryClientProvider>
  );
}

function renderDialog(): void {
  render(
    <ChatForkDialog
      open
      target={forkTarget()}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={() => undefined}
    />,
    { wrapper: ForkRuntimeTestProvider },
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

function stagedForkTarget(
  stagedSandbox: Extract<StagedSandboxTarget, { kind: "new" }>,
): ChatForkDialogTarget {
  return { ...forkTarget(), stagedSandbox };
}

function renderStaged(
  stagedSandbox: Extract<StagedSandboxTarget, { kind: "new" }>,
): void {
  render(
    <ChatForkDialog
      open
      target={stagedForkTarget(stagedSandbox)}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={dialogMocks.onOpenChange}
    />,
    { wrapper: ForkRuntimeTestProvider },
  );
}

function onlyPendingSend(): PendingSandboxSend {
  const sends = Object.values(usePendingSandboxSendStore.getState().sends);
  expect(sends).toHaveLength(1);
  return sends[0];
}

describe("ChatForkDialog on a New sandbox the chip picked", () => {
  beforeEach(() => {
    dialogMocks.createMutate.mockReset();
    dialogMocks.refetchAuthUser.mockReset();
    dialogMocks.refetchAuthUser.mockResolvedValue({
      data: null,
      isError: false,
    });
    dialogMocks.onOpenChange.mockReset();
    dialogMocks.needsOwnHostToast.mockReset();
    dialogMocks.attachCalls.length = 0;
    dialogMocks.attachRequests.length = 0;
    dialogMocks.attachAnswers = true;
    dialogMocks.stagingSeen.length = 0;
    dialogMocks.selectHost = null;
    dialogMocks.harnessAvailable = true;
    dialogMocks.catalog = "loaded";
    dialogMocks.seedModel = "claude-opus-4-7";
    dialogMocks.authStatus = "authenticated";
    dialogMocks.offeredAgents = undefined;
    dialogMocks.openForHarness.mockReset();
    dialogMocks.publication = { kind: "unknown" };
    dialogMocks.publicationReads.length = 0;
    dialogMocks.principal = { kind: "personal" };
    dialogMocks.openProviders.mockReset();
    dialogMocks.blocked.current = false;
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
    dialogMocks.directoryHosts = [directoryEntry(TAB_HOST_ID, "Tab host")];
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    useStagedSandboxStore.setState({ bySurface: {} });
    usePendingSandboxSendStore.setState({ sends: {} });
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
    resetHostDirectoryRows();
    resetNegotiatedManifests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("keeps a new agent pick while auth refresh is pending and validates it on the next Fork", async () => {
    const refreshed =
      Promise.withResolvers<
        Pick<QueryObserverResult<AuthenticatedUser | null>, "data" | "isError">
      >();
    dialogMocks.refetchAuthUser.mockReturnValue(refreshed.promise);
    dialogMocks.offeredAgents = ["claude"];
    renderStaged(NEW_SANDBOX);
    fillTitle();
    fireEvent.click(forkButton());
    await waitFor(() =>
      expect(dialogMocks.refetchAuthUser).toHaveBeenCalledOnce(),
    );
    const toolbar = dialogMocks.toolbarStore;
    if (toolbar === null) throw new Error("Expected the fork toolbar");
    act(() =>
      toolbar.getState().setSelection({
        harnessId: "codex",
        modelSlug: "gpt-6.1-sol",
        profileId: null,
      }),
    );
    await act(async () => {
      refreshed.resolve({ data: null, isError: false });
      await refreshed.promise;
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
    expect(toolbar.getState().values.selection.harnessId).toBe("codex");
    dialogMocks.refetchAuthUser.mockResolvedValue({
      data: null,
      isError: false,
    });
    fireEvent.click(forkButton());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Codex doesn't run on sandboxes",
    );
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
  });

  it("opens with the sandbox staged and the host list's staging surface handed to the controls", () => {
    renderStaged(NEW_SANDBOX);

    expect(readStagedSandbox(FORK_SURFACE)?.target).toEqual(NEW_SANDBOX);
    expect(dialogMocks.stagingSeen.at(-1)).not.toBeNull();
  });

  it("stages nothing and skips the publication read for a single-host fork", () => {
    renderDialog();

    expect(readStagedSandbox(FORK_SURFACE)).toBeNull();
    expect(dialogMocks.publicationReads.some((read) => read.enabled)).toBe(
      false,
    );
  });

  it("drops the stage when the dialog closes", () => {
    const { unmount } = render(
      <ChatForkDialog
        open
        target={stagedForkTarget(NEW_SANDBOX)}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
      { wrapper: ForkRuntimeTestProvider },
    );
    expect(readStagedSandbox(FORK_SURFACE)).not.toBeNull();

    unmount();

    expect(readStagedSandbox(FORK_SURFACE)).toBeNull();
  });

  it("hands Fork to the task as a pending fork, and sends nothing on the tab's host", async () => {
    dialogMocks.publication = { kind: "covered" };
    renderStaged(NEW_SANDBOX);
    fillTitle();

    fireEvent.click(forkButton());

    await waitFor(() => {
      expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(dialogMocks.publicationReads.some((read) => read.enabled)).toBe(
      true,
    );
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
    const send = onlyPendingSend();
    expect(send.epicId).toBe("epic-test");
    expect(send.request).toEqual({
      kind: "fork",
      parentId: null,
      title: "Sibling fork",
      forkSource: {
        boundary: "assistantMessage",
        sourceChatId: "source-chat",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: null,
        carriedInterviews: "settled",
        sourceOwnerUserId: null,
      },
      tabId: "tab-test",
    });
    expect(readStagedSandbox(FORK_SURFACE)).toBeNull();
    expect(readStagedSandbox(pendingSendSurfaceKey(send.id))?.target).toEqual(
      NEW_SANDBOX,
    );
  });

  it.each(["failed", "empty", "loading"] as const)(
    "hands Fork to the task as a pending fork though the selected host's model catalog is %s, and sends nothing on the tab's host",
    async (catalog) => {
      dialogMocks.publication = { kind: "covered" };
      dialogMocks.catalog = catalog;
      renderStaged(NEW_SANDBOX);
      fillTitle();

      expect(forkButton().disabled).toBe(false);
      fireEvent.click(forkButton());

      await waitFor(() => {
        expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
      });
      expect(dialogMocks.createMutate).not.toHaveBeenCalled();
      expect(onlyPendingSend().request.kind).toBe("fork");
    },
  );

  it("hands Fork to the task with no picked model slug, leaving the model to the destination", async () => {
    dialogMocks.publication = { kind: "covered" };
    dialogMocks.catalog = "failed";
    dialogMocks.seedModel = "";
    renderStaged(NEW_SANDBOX);
    fillTitle();

    expect(forkButton().disabled).toBe(false);
    fireEvent.click(forkButton());

    await waitFor(() => {
      expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
    expect(onlyPendingSend().request.kind).toBe("fork");
  });

  it("hands Fork to the task though the catalog of a selected EXISTING host failed", async () => {
    dialogMocks.publication = { kind: "covered" };
    dialogMocks.catalog = "failed";
    dialogMocks.directoryHosts = [
      directoryEntry(TAB_HOST_ID, "Tab host"),
      directoryEntry(OLD_HOST_ID, "Old host"),
    ];
    dialogMocks.clientsByHostId.set(OLD_HOST_ID, buildHostClient(OLD_HOST_ID));
    recordNegotiatedHostManifest(TAB_HOST_ID, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(OLD_HOST_ID, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    renderStaged(NEW_SANDBOX);
    act(() => {
      dialogMocks.selectHost?.(OLD_HOST_ID);
    });
    fillTitle();

    expect(forkButton().disabled).toBe(false);
    fireEvent.click(forkButton());

    await waitFor(() => {
      expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(onlyPendingSend().request.kind).toBe("fork");
  });

  it("uses the staged sandbox as the unknown destination despite v1.0 source and selected hosts, then restores the selected host refusal when cleared", () => {
    dialogMocks.publication = { kind: "covered" };
    dialogMocks.directoryHosts = [
      directoryEntry(TAB_HOST_ID, "Tab host"),
      directoryEntry(OLD_HOST_ID, "Old host"),
    ];
    dialogMocks.clientsByHostId.set(OLD_HOST_ID, buildHostClient(OLD_HOST_ID));
    recordNegotiatedHostManifest(TAB_HOST_ID, {
      "epic.createChat": { major: 1, minor: 0 },
    });
    recordNegotiatedHostManifest(OLD_HOST_ID, {
      "epic.createChat": { major: 1, minor: 0 },
    });
    renderStaged(NEW_SANDBOX);
    act(() => {
      dialogMocks.selectHost?.(OLD_HOST_ID);
    });
    fillTitle();

    expect(dialogMocks.publicationReads.some((read) => read.enabled)).toBe(
      true,
    );
    expect(screen.queryByTestId("chat-fork-target-refused")).toBeNull();
    expect(forkButton().disabled).toBe(false);

    act(() => {
      useStagedSandboxStore.getState().clear(FORK_SURFACE);
    });

    expect(readStagedSandbox(FORK_SURFACE)).toBeNull();
    expect(
      screen.getByTestId("chat-fork-target-refused").textContent,
    ).toContain("can't receive a fork from another computer");
    expect(forkButton().disabled).toBe(true);
  });

  it("keeps a known uncovered source boundary blocking a staged fork even when the selected host is v1.0", () => {
    dialogMocks.publication = { kind: "boundaryUncovered" };
    dialogMocks.directoryHosts = [
      directoryEntry(TAB_HOST_ID, "Tab host"),
      directoryEntry(OLD_HOST_ID, "Old host"),
    ];
    dialogMocks.clientsByHostId.set(OLD_HOST_ID, buildHostClient(OLD_HOST_ID));
    recordNegotiatedHostManifest(TAB_HOST_ID, {
      "epic.createChat": { major: 1, minor: 0 },
    });
    recordNegotiatedHostManifest(OLD_HOST_ID, {
      "epic.createChat": { major: 1, minor: 0 },
    });
    renderStaged(NEW_SANDBOX);
    act(() => {
      dialogMocks.selectHost?.(OLD_HOST_ID);
    });
    fillTitle();

    expect(dialogMocks.publicationReads.some((read) => read.enabled)).toBe(
      true,
    );
    expect(
      screen.getByTestId("chat-fork-publication-notice").textContent,
    ).toContain("Still syncing this turn to the cloud");
    expect(forkButton().disabled).toBe(true);
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
      [],
    );
  });

  it("blocks a staged remote fork while its source boundary is still syncing", () => {
    dialogMocks.publication = { kind: "boundaryUncovered" };
    renderStaged(NEW_SANDBOX);
    fillTitle();

    expect(dialogMocks.publicationReads.some((read) => read.enabled)).toBe(
      true,
    );
    expect(
      screen.getByTestId("chat-fork-publication-notice").textContent,
    ).toContain("Still syncing this turn to the cloud");
    expect(forkButton().disabled).toBe(true);

    fireEvent.click(forkButton());

    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
      [],
    );
    expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
    expect(readStagedSandbox(FORK_SURFACE)?.phase).toBe("staged");
  });

  it("attaches the task to a team's sandbox before handing the fork over", async () => {
    renderStaged({
      ...NEW_SANDBOX,
      configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
    });
    fillTitle();

    fireEvent.click(forkButton());

    await waitFor(() => {
      expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(dialogMocks.attachCalls).toEqual([
      { epicId: "epic-test", teamId: "team-9" },
    ]);
    expect(onlyPendingSend().request.kind).toBe("fork");
  });

  it("says a team's sandbox needs the person's own host to be attached from, and hands nothing over, when none can send it", async () => {
    // Neither the source tab's host nor the app-wide one can send the
    // attachment: both are a team's sandbox, and a team's host would send it
    // with a member's credential.
    installHostDirectoryRows([
      sandboxHostEntry(TAB_HOST_ID, { id: "team-1", name: "Other" }),
    ]);
    renderStaged({
      ...NEW_SANDBOX,
      configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
    });
    fillTitle();

    fireEvent.click(forkButton());

    await waitFor(() =>
      expect(dialogMocks.needsOwnHostToast).toHaveBeenCalledTimes(1),
    );
    expect(dialogMocks.attachCalls).toEqual([]);
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
      [],
    );
    expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
  });

  it("hands nothing over while the attach has not answered", async () => {
    dialogMocks.attachAnswers = false;
    renderStaged({
      ...NEW_SANDBOX,
      configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
    });
    fillTitle();

    fireEvent.click(forkButton());

    await waitFor(() => expect(dialogMocks.attachCalls).toHaveLength(1));
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
      [],
    );
    expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
  });

  describe("while a team's attach has not answered", () => {
    const TEAM_A: Extract<StagedSandboxTarget, { kind: "new" }> = {
      ...NEW_SANDBOX,
      configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
    };
    const TEAM_B: Extract<StagedSandboxTarget, { kind: "new" }> = {
      ...NEW_SANDBOX,
      configuration: { kind: "team", teamId: "team-10", teamName: "Beta" },
    };

    async function startPendingAttach(): Promise<void> {
      dialogMocks.attachAnswers = false;
      renderStaged(TEAM_A);
      fillTitle();
      fireEvent.click(forkButton());
      await waitFor(() =>
        expect(dialogMocks.attachCalls).toEqual([
          { epicId: "epic-test", teamId: "team-9" },
        ]),
      );
    }

    it.each([
      ["another team", TEAM_B, "team-10"],
      ["Personal", NEW_SANDBOX, null],
    ] as const)(
      "hands nothing over, for the old or the new stage, when the stage is retargeted to %s and the first attach answers",
      async (_label, retarget, teamId) => {
        await startPendingAttach();
        act(() => {
          useStagedSandboxStore.getState().stage(FORK_SURFACE, retarget);
        });

        act(() => {
          dialogMocks.attachRequests[0].onSuccess();
        });

        expect(
          Object.keys(usePendingSandboxSendStore.getState().sends),
        ).toEqual([]);
        expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
        expect(readStagedSandbox(FORK_SURFACE)).toMatchObject({
          phase: "staged",
          target: retarget,
        });

        // The new stage is forked on its own: its team attached first.
        dialogMocks.attachAnswers = true;
        fireEvent.click(forkButton());
        await waitFor(() => {
          expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
        });
        expect(dialogMocks.attachCalls).toEqual(
          teamId === null
            ? [{ epicId: "epic-test", teamId: "team-9" }]
            : [
                { epicId: "epic-test", teamId: "team-9" },
                { epicId: "epic-test", teamId },
              ],
        );
        expect(
          readStagedSandbox(pendingSendSurfaceKey(onlyPendingSend().id))
            ?.target,
        ).toEqual(retarget);
      },
    );

    it("hands nothing over when the attach answers after the account changed", async () => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-1", userName: "U", email: "u@example.com" },
          { userId: "user-1", username: "U" },
          [],
        );
      await startPendingAttach();
      act(() => {
        useAuthStore.getState().setSignedOut();
        useAuthStore
          .getState()
          .setSignedIn(
            { userId: "user-2", userName: "V", email: "v@example.com" },
            { userId: "user-2", username: "V" },
            [],
          );
      });

      act(() => {
        dialogMocks.attachRequests[0].onSuccess();
      });

      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
      expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
    });
  });

  describe("when the staged agent is not offered on sandboxes", () => {
    const NOT_OFFERED =
      "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.";

    it("refuses an unoffered Fork with its own model picker, handing nothing over and keeping the stage and title", async () => {
      dialogMocks.offeredAgents = ["traycer"];
      renderStaged(NEW_SANDBOX);
      fillTitle();

      fireEvent.click(forkButton());

      const notice = await screen.findByRole("alert");
      expect(notice.textContent).toContain(NOT_OFFERED);
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
      expect(dialogMocks.attachCalls).toEqual([]);
      expect(dialogMocks.createMutate).not.toHaveBeenCalled();
      expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
      expect(readStagedSandbox(FORK_SURFACE)?.phase).toBe("staged");
      expect(
        screen.getByRole<HTMLInputElement>("textbox", {
          name: "Fork agent title",
        }).value,
      ).toBe("Sibling fork");

      fireEvent.click(screen.getByTestId("composer-host-notice-action"));
      expect(dialogMocks.openForHarness).toHaveBeenCalledWith("traycer", [
        "traycer",
      ]);
    });

    it("follows the pick after the refusal: another unoffered agent switches the line, an offered one clears it", async () => {
      dialogMocks.offeredAgents = ["traycer"];
      renderStaged(NEW_SANDBOX);
      fillTitle();
      fireEvent.click(forkButton());
      expect((await screen.findByRole("alert")).textContent).toContain(
        NOT_OFFERED,
      );
      const toolbar = dialogMocks.toolbarStore;
      if (toolbar === null) throw new Error("Expected the fork toolbar");

      act(() =>
        toolbar.getState().setSelection({
          harnessId: "codex",
          modelSlug: "gpt-6.1-sol",
          profileId: null,
        }),
      );
      expect(screen.getByRole("alert").textContent).toContain(
        "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      );

      act(() =>
        toolbar.getState().setSelection({
          harnessId: "traycer",
          modelSlug: "claude-sonnet-5.5",
          profileId: null,
        }),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    it("refuses the same unoffered agent on a team sandbox before attaching", async () => {
      dialogMocks.offeredAgents = ["traycer"];
      dialogMocks.principal = { kind: "team", teamName: "Acme" };
      renderStaged({
        ...NEW_SANDBOX,
        configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
      });
      fillTitle();

      fireEvent.click(forkButton());

      expect((await screen.findByRole("alert")).textContent).toContain(
        NOT_OFFERED,
      );
      expect(dialogMocks.attachCalls).toEqual([]);
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
    });

    it("hands an offered agent over despite desktop sign-out", async () => {
      dialogMocks.offeredAgents = ["claude"];
      dialogMocks.authStatus = "unauthenticated";
      dialogMocks.principal = { kind: "team", teamName: "Acme" };
      renderStaged(NEW_SANDBOX);
      fillTitle();

      fireEvent.click(forkButton());

      await waitFor(() => {
        expect(dialogMocks.onOpenChange).toHaveBeenCalledWith(false);
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onlyPendingSend().request.kind).toBe("fork");
    });
  });

  describe("on a sandbox host with nothing staged", () => {
    const SENTENCE = "Agents can't run on this sandbox.";

    beforeEach(() => {
      installHostDirectoryRows([
        sandboxHostEntry(TAB_HOST_ID, null),
        plainHostEntry("laptop-host"),
      ]);
      dialogMocks.directoryHosts = [
        directoryEntry(TAB_HOST_ID, "Tab host"),
        directoryEntry("laptop-host", "Laptop"),
      ];
      dialogMocks.clientsByHostId.set(
        "laptop-host",
        buildHostClient("laptop-host"),
      );
    });

    it("refuses Fork for an agent the sandbox cannot run, choosing a model and with no Providers link, creating, attaching and handing nothing, and keeping the dialog, title and chip", () => {
      dialogMocks.harnessAvailable = false;
      renderDialog();
      fillTitle();

      fireEvent.click(forkButton());

      expect(screen.getByRole("alert").textContent).toContain(SENTENCE);
      expect(dialogMocks.createMutate).not.toHaveBeenCalled();
      expect(dialogMocks.attachCalls).toEqual([]);
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
      expect(dialogMocks.onOpenChange).not.toHaveBeenCalled();
      expect(
        screen.getByRole<HTMLInputElement>("textbox", {
          name: "Fork agent title",
        }).value,
      ).toBe("Sibling fork");
      expect(
        screen.getByRole("button", { name: "Harness picker" }),
      ).toBeTruthy();

      expect(
        screen.getByTestId("composer-host-notice-action").textContent,
      ).toBe("Choose a model");
      expect(screen.getByRole("alert").textContent).not.toContain("Providers");
    });

    it("retires the notice when another host is picked", () => {
      dialogMocks.harnessAvailable = false;
      renderDialog();
      fillTitle();
      fireEvent.click(forkButton());
      expect(screen.getByRole("alert")).toBeTruthy();

      act(() => {
        dialogMocks.selectHost?.("laptop-host");
      });

      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("forks as always when the agent can run on the sandbox", async () => {
      renderDialog();
      fillTitle();

      fireEvent.click(forkButton());

      await waitFor(() => {
        expect(dialogMocks.createMutate).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
