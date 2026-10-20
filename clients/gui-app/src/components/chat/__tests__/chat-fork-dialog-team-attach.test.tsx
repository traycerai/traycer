import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const TAB_HOST_ID = "tab-host-id";
const TEAM_HOST_ID = "team-host-id";
const TEAM_ID = "team-9";

interface BlockedInput {
  readonly hostId: string | null;
  readonly harnessId: string | null;
}

const dialogMocks = vi.hoisted(() => ({
  /** Every `epic.createChat` the dialog sent, with the client it was sent on. */
  creates: [] as Array<{ readonly client: unknown; readonly input: unknown }>,
  events: [] as string[],
  clientsByHostId: new Map<string, unknown>(),
  directoryHosts: [] as HostDirectoryEntry[],
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(
      (...args: Parameters<typeof actual.toast>) => actual.toast(...args),
      actual.toast,
      { error: dialogMocks.toastError },
    ),
  };
});

vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => ({
  useTeamSandboxHarnessBlocked: (): boolean => false,
  useTeamSandboxHarnessGate: () => (): boolean => false,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: (client: unknown) => ({
    mutate: (input: unknown) => {
      dialogMocks.events.push("create");
      dialogMocks.creates.push({ client, input });
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

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

vi.mock("@/hooks/host/use-host-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/host/use-host-query")>()),
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
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude Opus
    </button>
  ),
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
    ActiveHostWorkspaceControls: () => <div data-testid="fork-workspace" />,
  }),
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    data: {
      models: [
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
    isPending: false,
  }),
}));

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

const FORBIDDEN_COPY = "Ask the task's owner to continue it on a team host.";

function personalEntry(hostId: string, label: string): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };
}

/** A team's sandbox: a remote row whose `sandbox.ownerTeamId` names the team. */
function teamSandboxEntry(hostId: string, teamId: string): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: "Team sandbox",
    kind: "remote",
    websocketUrl: "wss://relay.invalid/attach",
    version: "1.2.3",
    transportDialability: "dialable",
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    publicKey: `pubkey-${hostId}`,
    relayFuseGrace: false,
    sandbox: {
      state: "running",
      frozen: false,
      profile: "agent",
      ownerTeamName: "Team",
      ownerTeamId: teamId,
    },
  };
}

interface AttachCall {
  readonly params: unknown;
  readonly settle: (outcome: "resolve" | HostRpcError) => void;
}

/** `epic.attachEnvironment` calls the person's host received, held open. */
const attachCalls: AttachCall[] = [];

function attachHandler(
  hostId: string,
): (params: unknown) => Promise<{ readonly attached: true }> {
  return (params) =>
    new Promise((resolve, reject) => {
      dialogMocks.events.push(`attach-sent@${hostId}`);
      attachCalls.push({
        params,
        settle: (outcome) => {
          dialogMocks.events.push("attach-settled");
          if (outcome === "resolve") resolve({ attached: true });
          else reject(outcome);
        },
      });
    });
}

function buildHostClient(
  entry: HostDirectoryEntry,
  withAttachHandler: boolean,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${entry.hostId}`,
      handlers: withAttachHandler
        ? {
            "epic.attachEnvironment": (params) =>
              attachHandler(entry.hostId)(params),
          }
        : {},
    }),
    findHostById: (id) => (id === entry.hostId ? entry : null),
  });
  // The person's authenticated request context: without one the client
  // refuses every request before the messenger.
  spine.setRequestContext(
    createRequestContext({
      identity: identityFromAuthenticatedUser(
        createAuthenticatedUserFixture(undefined),
      ),
      bearerToken: "person-bearer",
      origin: "renderer",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
      cloudAuthorized: true,
    }),
  );
  return spine.createRequester(entry);
}

const TAB_ENTRY = personalEntry(TAB_HOST_ID, "Personal host");
const TEAM_ENTRY = teamSandboxEntry(TEAM_HOST_ID, TEAM_ID);
// The attachment is sent on the person's own host: the tab host's client is
// the app-wide client here. The team host's client has no attach handler, so
// an attach sent to it would fail loudly instead of resolving.
const TAB_HOST_CLIENT = buildHostClient(TAB_ENTRY, true);
const TEAM_HOST_CLIENT = buildHostClient(TEAM_ENTRY, false);

const SETTINGS_SEED: ChatRunSettings = {
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
    settingsSeed: SETTINGS_SEED,
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
    initialHostId: TEAM_HOST_ID,
    onlyHostIds: null,
  };
}

const onOpenChange = vi.fn<(open: boolean) => void>();

/**
 * Mounted closed, then opened: the target's `initialHostId` seeds the selected
 * host only on an open TRANSITION.
 */
function renderDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const ui = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <ChatForkDialog
        open={open}
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  );
  const view = render(ui(false));
  view.rerender(ui(true));
}

function fillTitle(): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Fork agent title" }), {
    target: { value: "Sibling fork" },
  });
}

function forkButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Fork" });
}

function rpcError(code: "FORBIDDEN" | "E_HOST_UNSUPPORTED" | "RPC_ERROR"): HostRpcError {
  return new HostRpcError({
    code,
    message: "refused by the host",
    requestId: "req-attach",
    method: "epic.attachEnvironment",
    fatalDetails: null,
  });
}

/** Lets promise continuations and the mutation observer settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function startFork(): Promise<void> {
  renderDialog();
  fillTitle();
  expect(forkButton().disabled).toBe(false);
  fireEvent.click(forkButton());
  await waitFor(() => {
    expect(attachCalls).toHaveLength(1);
  });
}

describe("ChatForkDialog continuing a personal task on a team host", () => {
  beforeEach(() => {
    dialogMocks.creates.length = 0;
    dialogMocks.events.length = 0;
    dialogMocks.toastError.mockReset();
    attachCalls.length = 0;
    onOpenChange.mockReset();
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
    dialogMocks.clientsByHostId.set(TEAM_HOST_ID, TEAM_HOST_CLIENT);
    dialogMocks.directoryHosts = [TAB_ENTRY, TEAM_ENTRY];
    const rows = new Map<string, HostDirectoryEntry>([
      [TAB_HOST_ID, TAB_ENTRY],
      [TEAM_HOST_ID, TEAM_ENTRY],
    ]);
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => rows.get(hostId) ?? null,
        onDirectoryChanged: () => ({ dispose: () => undefined }),
      },
      leases: null,
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  afterEach(() => {
    resetNegotiatedManifests();
    resetHostConnectionRegistryForTest();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("attaches on the person's host first and creates on the team host only once that resolves", async () => {
    await startFork();

    expect(attachCalls[0]?.params).toEqual({
      epicId: "epic-test",
      teamId: TEAM_ID,
    });
    await flush();
    expect(dialogMocks.creates).toHaveLength(0);

    attachCalls[0]?.settle("resolve");
    await waitFor(() => {
      expect(dialogMocks.creates).toHaveLength(1);
    });
    expect(dialogMocks.creates[0]?.client).toBe(TEAM_HOST_CLIENT);
    expect(dialogMocks.creates[0]?.input).toMatchObject({
      epicId: "epic-test",
      hostId: TEAM_HOST_ID,
    });
    expect(dialogMocks.events).toEqual([
      `attach-sent@${TAB_HOST_ID}`,
      "attach-settled",
      "create",
    ]);
  });

  it("sends no create when the attachment fails for any other reason", async () => {
    await startFork();

    attachCalls[0]?.settle(rpcError("RPC_ERROR"));
    await flush();

    expect(dialogMocks.creates).toHaveLength(0);
    expect(dialogMocks.events).toEqual([
      `attach-sent@${TAB_HOST_ID}`,
      "attach-settled",
    ]);
  });

  it("stops on a refusal with the one line a person can act on, creates nothing and stays open", async () => {
    await startFork();

    attachCalls[0]?.settle(rpcError("FORBIDDEN"));
    await waitFor(() => {
      expect(dialogMocks.toastError).toHaveBeenCalledTimes(1);
    });

    expect(dialogMocks.toastError).toHaveBeenCalledWith(FORBIDDEN_COPY);
    expect(FORBIDDEN_COPY).not.toMatch(
      /epic\.|attach|route|\/api|\brow\b|record|permission|[a-z]+_[a-z]+|\bid\b/i,
    );
    expect(dialogMocks.creates).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Fork agent title" }),
    ).toBeTruthy();
  });

  it("goes on to create on the team host, with no toast, when the host predates the attachment", async () => {
    await startFork();

    attachCalls[0]?.settle(rpcError("E_HOST_UNSUPPORTED"));
    await waitFor(() => {
      expect(dialogMocks.creates).toHaveLength(1);
    });

    expect(dialogMocks.creates[0]?.client).toBe(TEAM_HOST_CLIENT);
    expect(dialogMocks.toastError).not.toHaveBeenCalled();
  });
});
