/**
 * The chat fork dialog holds Fork shut on a harness a team sandbox does not
 * offer.
 *
 * A fork seeds its harness from the source chat and runs on the selected host.
 * When that host is a team sandbox and the harness is one it does not offer,
 * the dialog says so and Fork stays disabled; on any other combination Fork is
 * as available as it always was. The decision itself is the hook's
 * (`useTeamSandboxHarnessBlocked`), mocked here so the dialog's use of the
 * answer is what is under test.
 */
import {
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

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [] },
    isFetching: false,
    isError: false,
  }),
}));

// A fork that stages no sandbox never asks the staged sign-in check anything.
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => null,
    beforeSend: () => Promise.resolve(null),
  }),
}));

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

const UNAVAILABLE_TESTID = "fork-team-sandbox-unavailable";

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
    initialHostId: null,
    onlyHostIds: null,
    stagedSandbox: null,
    carriesComposerDraft: false,
  };
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

describe("ChatForkDialog on a team sandbox", () => {
  beforeEach(() => {
    dialogMocks.createMutate.mockReset();
    dialogMocks.blocked.current = false;
    dialogMocks.blockedInputs.length = 0;
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
    dialogMocks.directoryHosts = [directoryEntry(TAB_HOST_ID, "Tab host")];
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  afterEach(() => {
    resetNegotiatedManifests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("asks about the selected host and the forked harness", () => {
    renderDialog();

    expect(dialogMocks.blockedInputs).toContainEqual({
      hostId: TAB_HOST_ID,
      harnessId: "claude",
    });
  });

  it("says the harness is not available on team sandboxes and holds Fork shut when it is blocked", () => {
    dialogMocks.blocked.current = true;
    renderDialog();
    fillTitle();

    const line = screen.getByTestId(UNAVAILABLE_TESTID);
    expect(line.textContent).toBe("Not available on team sandboxes.");
    expect(forkButton().disabled).toBe(true);

    fireEvent.click(forkButton());
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
  });

  it("shows no such line and leaves Fork enabled when the harness is not blocked", async () => {
    dialogMocks.blocked.current = false;
    renderDialog();
    fillTitle();

    expect(screen.queryByTestId(UNAVAILABLE_TESTID)).toBeNull();
    expect(forkButton().disabled).toBe(false);

    fireEvent.click(forkButton());
    await waitFor(() => {
      expect(dialogMocks.createMutate).toHaveBeenCalledTimes(1);
    });
  });
});
