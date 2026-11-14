import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
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
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import type { RemovedProviderProfile } from "@/components/providers/provider-profile-model";

const dialogMocks = vi.hoisted(() => ({
  createMutate:
    vi.fn<(input: { readonly settings: ChatRunSettings | null }) => void>(),
  providersByClient: new Map<unknown, ProviderCliState[]>(),
  removedByClient: new Map<unknown, RemovedProviderProfile[]>(),
  clientsByHostId: new Map<string, unknown>(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({ hosts: [] });
  return { useHostOptions: () => options };
});
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHost: () => ({
    mutate: dialogMocks.createMutate,
    isPending: false,
    error: null,
    variables: null,
    reset: () => undefined,
    data: null,
    isError: false,
    isSuccess: false,
    status: "idle",
  }),
  useEpicCreateChatForHostClient: () => ({
    mutate: dialogMocks.createMutate,
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
  return { ...actual, useHostClient: () => TAB_HOST_CLIENT };
});
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "tab-host-id",
        label: "Tab host",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/tab-host-id",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
    ],
  }),
}));
vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: () => null,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "tab-host-id",
}));
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
  useHostQuery: (args: {
    readonly client: unknown;
    readonly options: { readonly enabled: boolean } | null | undefined;
  }) => {
    const enabled =
      args.options !== null &&
      args.options !== undefined &&
      args.options.enabled;
    if (!enabled) return { data: undefined };
    const providers = dialogMocks.providersByClient.get(args.client);
    if (providers === undefined) return { data: undefined };
    return {
      data: {
        providers,
        native: null,
        removedProfiles: dialogMocks.removedByClient.get(args.client) ?? [],
      },
    };
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
    ActiveHostWorkspaceControls: () => null,
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
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => null,
    beforeSend: () => Promise.resolve(null),
  }),
}));

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = {
    hostId,
    label: hostId,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

const TAB_HOST_CLIENT = buildHostClient("tab-host-id");

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: input.aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

function forkTarget(profileId: string | null): ChatForkDialogTarget {
  return {
    sourceChatId: "source-chat",
    sourceChatTitle: "Source chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    parentId: null,
    settingsSeed: {
      ultracode: false,
      harnessId: "claude",
      model: "claude-opus-4-7",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId,
    },
    workspaceSeed: {
      workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
      intent: null,
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

function install(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: readonly RemovedProviderProfile[];
}): void {
  dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
    providerState({
      providerId: "claude-code",
      authStatus: "authenticated",
      profiles: input.profiles,
    }),
  ]);
  dialogMocks.removedByClient.set(TAB_HOST_CLIENT, [...input.removed]);
}

function renderDialog(profileId: string | null): void {
  render(
    <ChatForkDialog
      open
      target={forkTarget(profileId)}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={() => undefined}
    />,
    { wrapper: WithTestQueryClient },
  );
}

function forkButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Fork" });
}

function titleTheFork(): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Fork agent title" }), {
    target: { value: "Sibling fork" },
  });
}

async function submitFork(): Promise<{
  readonly settings: ChatRunSettings | null;
}> {
  titleTheFork();
  await waitFor(() => {
    expect(forkButton().disabled).toBe(false);
  });
  fireEvent.click(forkButton());
  await waitFor(() => {
    expect(dialogMocks.createMutate).toHaveBeenCalled();
  });
  return dialogMocks.createMutate.mock.calls[0][0];
}

const side = managed({ profileId: "side-row", label: "Side", aliases: [] });
const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
});

describe("ChatForkDialog pin", () => {
  beforeEach(() => {
    dialogMocks.providersByClient.clear();
    dialogMocks.removedByClient.clear();
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set("tab-host-id", TAB_HOST_CLIENT);
    dialogMocks.createMutate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("a fork seeded on an alias keeps the canonical account", async () => {
    install({ profiles: [side, work], removed: [] });
    renderDialog("alias-work");
    const request = await submitFork();
    expect(request.settings?.profileId).toBe("work-row");
  });

  it("Fork stays disabled while the seed is a removed profile id", async () => {
    install({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "claude-code",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
    });
    renderDialog("gone-row");
    titleTheFork();
    await waitFor(() => {
      expect(forkButton().disabled).toBe(true);
    });
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
  });

  it("Fork stays disabled while the seed is a removed entry's alias", async () => {
    install({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "claude-code",
          profileId: "gone-row",
          aliases: ["gone-alias"],
        }),
      ],
    });
    renderDialog("gone-alias");
    titleTheFork();
    await waitFor(() => {
      expect(forkButton().disabled).toBe(true);
    });
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
  });

  it("an unknown seed submits on the Terminal login", async () => {
    install({ profiles: [side, work], removed: [] });
    renderDialog("missing-id");
    const request = await submitFork();
    expect(request.settings?.profileId).toBeNull();
  });
});
