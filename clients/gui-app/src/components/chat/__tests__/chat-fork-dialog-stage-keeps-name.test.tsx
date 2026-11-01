/**
 * A fork dialog onto a staged sandbox keeps the name of a Traycer model the
 * sandbox's own list leaves out on the real model picker's trigger.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const TAB_HOST_ID = "tab-host-id";

interface BlockedInput {
  readonly hostId: string | null;
  readonly harnessId: string | null;
}

const dialogMocks = vi.hoisted(() => ({
  createMutate: vi.fn<(input: unknown, options: unknown) => void>(),
  blocked: { current: false },
  blockedInputs: [] as Array<{
    readonly hostId: string | null;
    readonly harnessId: string | null;
  }>,
  clientsByHostId: new Map<string, unknown>(),
  directoryHosts: [] as HostDirectoryEntry[],
  /** The sandbox's own Traycer list, by slug. */
  cloudModels: ["trc-s"] as ReadonlyArray<string>,
}));

// The cloud's Traycer catalog, read only for a Traycer pick sent to a sandbox.
import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  // The query's own shape; this dialog's list is always answered.
  useSandboxTraycerModels: () => {
    return {
      data: cloudModelOptions(),
      isPending: false,
      isFetching: false,
      fetchStatus: "idle" as const,
      isError: false,
    };
  },
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://billing.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

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
      hostId: TAB_HOST_ID,
      hostClient: dialogMocks.clientsByHostId.get(TAB_HOST_ID),
      directory: { selectById: vi.fn() },
    }),
  };
});

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  // The directory's rows as host options, one object per list.
  let cached: {
    readonly from: readonly HostDirectoryEntry[];
    readonly options: HostOptions;
  } | null = null;
  return {
    useHostOptions: () => {
      if (cached?.from !== dialogMocks.directoryHosts)
        cached = {
          from: dialogMocks.directoryHosts,
          options: hostOptionsFixture({
            hosts: dialogMocks.directoryHosts.map((entry) =>
              hostScopeOptionFixture({
                hostId: entry.hostId,
                name: entry.label,
                isLocalMachine: false,
              }),
            ),
          }),
        };
      return cached.options;
    },
  };
});
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: dialogMocks.directoryHosts }),
}));

// The binding here is a bare fake with no directory for the real hook to read.
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: () => null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

// The attachment before a fork onto a team's host: passed straight through,
// so every fork here goes on to `epic.createChat` as it did before.
vi.mock("@/hooks/epic/use-epic-attach-environment-mutation", () => ({
  isAttachEnvironmentUnsupported: () => false,
  toastAttachEnvironmentNeedsOwnHost: () => undefined,
  useEpicAttachEnvironment: () => ({
    isPending: false,
    mutate: (_input: unknown, options: { readonly onSuccess: () => void }) => {
      options.onSuccess();
    },
  }),
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

function modelOption(
  harnessId: GuiHarnessId,
  slug: string,
  label: string,
): ModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}
// Stable references: a fresh list per render would push a new catalog on
// every render.
const CLAUDE_MODELS = {
  models: [modelOption("claude", "claude-opus-4-7", "Claude Opus")],
};
const TRAYCER_HOST_MODELS = {
  models: [modelOption("traycer", "trc-a", "Traycer A")],
};
let cloudCache: {
  readonly from: ReadonlyArray<string>;
  readonly options: ReadonlyArray<ModelOption>;
} | null = null;
function cloudModelOptions() {
  const slugs = dialogMocks.cloudModels;
  if (cloudCache?.from !== slugs)
    cloudCache = {
      from: slugs,
      options: slugs.map((slug) => modelOption("traycer", slug, slug)),
    };
  return cloudCache.options;
}

vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/harnesses/use-gui-harness-catalog")
    >()),
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
          {
            id: "traycer",
            label: "Traycer",
            available: true,
            error: null,
            modes: ["gui"],
            requiresApiKey: false,
            supportedPermissionModes: ["supervised"],
          },
        ],
      },
      isPending: false,
    }),
    useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) =>
      harnessId === "traycer"
        ? { data: TRAYCER_HOST_MODELS, isPending: false }
        : { data: CLAUDE_MODELS, isPending: false },
  }),
);

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [] },
    isFetching: false,
    isError: false,
  }),
}));

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

// The dialog's staging surface, one per tab (`chatForkSurfaceKey`).
const FORK_SURFACE = "chat-fork:epic-test:tab-test";

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
  harnessId: "traycer",
  model: "trc-a",
  permissionMode: "supervised",
  reasoningEffort: null,
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
    initialHostId: null,
    onlyHostIds: null,
    stagedSandbox: {
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
    },
    carriesComposerDraft: false,
  };
}

function renderDialog(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatForkDialog
        open
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("ChatForkDialog model chip onto a staged sandbox", () => {
  beforeEach(() => {
    dialogMocks.createMutate.mockReset();
    dialogMocks.blocked.current = false;
    dialogMocks.blockedInputs.length = 0;
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
    dialogMocks.directoryHosts = [directoryEntry(TAB_HOST_ID, "Tab host")];
    dialogMocks.cloudModels = ["trc-s"];
    useStagedSandboxStore.setState({ bySurface: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  afterEach(() => {
    resetNegotiatedManifests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    useStagedSandboxStore.setState({ bySurface: {} });
    cleanup();
  });

  it("names the model on the trigger when the sandbox's list leaves it out", async () => {
    renderDialog();
    await waitFor(() =>
      expect(
        useStagedSandboxStore.getState().bySurface[FORK_SURFACE],
      ).toBeDefined(),
    );

    expect(
      await screen.findByRole("button", { name: /^Traycer A/ }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Select model/ })).toBeNull();
  });
});
