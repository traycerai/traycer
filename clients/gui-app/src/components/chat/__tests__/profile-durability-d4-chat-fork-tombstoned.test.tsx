import "../../../../__tests__/test-browser-apis";
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
import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * D4 (durability audit), end-to-end for `chat-fork-dialog.tsx`: "Fork dialog
 * seeded from a chat whose profile is now tombstoned: falls back to ambient
 * for the new selection; no crash."
 *
 * A cold reviewer flagged the FIRST version of this fix: the seed-resolution
 * hook originally read `providers.list` from the app-wide ACTIVE host
 * instead of the host the fork's `createChat` call actually targets - the
 * TAB's host (`useEpicCreateChatForHost` -> `useTabHostClient`). `mock
 * useHostQuery` here is keyed by the EXACT `client` reference it's called
 * with, so the cross-host tests below prove the dialog reads from
 * `useTabHostClient()`'s result and never a decoy "active host" client.
 */

const dialogMocks = vi.hoisted(() => ({
  createMutate:
    vi.fn<
      (input: ChatForkCreateInput, options: ChatForkMutationOptions) => void
    >(),
  providersByClient: new Map<unknown, ProviderCliState[]>(),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHost: () => ({
    mutate: dialogMocks.createMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => TAB_HOST_CLIENT,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "tab-host-id",
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: unknown;
    readonly options: { readonly enabled: boolean } | null;
  }) => {
    if (!(args.options?.enabled ?? false)) return { data: undefined };
    const providers = dialogMocks.providersByClient.get(args.client);
    return { data: providers === undefined ? undefined : { providers } };
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
  useGuiHarnessesQuery: () => ({
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
  useGuiHarnessModelsQuery: () => ({
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
import {
  pendingForkChatStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

interface ChatForkCreateInput {
  readonly settings: ChatRunSettings | null;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
  readonly worktreeIntent: WorktreeIntent | null;
}

interface ChatForkMutationOptions {
  readonly onSuccess: (result: { readonly chatId: string }) => void;
}

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    // `useHostQuery` is mocked wholesale below, so this messenger's handlers
    // are never actually invoked - this just needs to be a real, distinct
    // `HostClient` instance to key `dialogMocks.providersByClient` by.
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    status: "available",
  });
  return client;
}

// The tab's own host client (`useTabHostClient()`'s mocked result) - the
// ONLY client the fork's `createChat` call and the seeded-profile
// validation are supposed to read from.
const TAB_HOST_CLIENT = buildHostClient("tab-host");
// A decoy standing in for "the app-wide active host" - something the dialog
// must NEVER read profiles from. Never returned by any mocked hook below.
const DECOY_ACTIVE_HOST_CLIENT = buildHostClient("decoy-active-host");

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    kind,
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
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  return {
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
    profiles,
  };
}

function forkTarget(profileId: string | null): ChatForkDialogTarget {
  return {
    sourceChatId: "source-chat",
    sourceChatTitle: "Source chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    parentId: null,
    settingsSeed: {
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
    // A plain fork, matching `forkAtAssistantMessage`'s non-"ab-worktree"
    // branch: no worktree pre-selection override, no re-opened interviews.
    // This file's tombstoned-profile scenarios are orthogonal to fork-mode
    // presentation, so any mode would do here - "plain" is the simplest.
    seedIntentOverride: null,
    carriedInterviews: "settled",
    forkMode: "plain",
  };
}

function renderDialog(target: ChatForkDialogTarget): void {
  render(
    <ChatForkDialog
      open
      target={target}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={() => undefined}
    />,
  );
}

async function submitFork(): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: "Fork chat title" }), {
    target: { value: "Sibling fork" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fork" }));
  await waitFor(() => {
    expect(dialogMocks.createMutate).toHaveBeenCalled();
  });
}

function seedLiveForkWorkspace(): void {
  const stagingKey = pendingForkChatStagingKey("epic-test");
  const folder = {
    path: "/repo/lifecycle",
    name: "lifecycle",
    repoIdentifier: null,
  };
  useSeededWorkspaceSnapshotStore.getState().setSnapshot(stagingKey, {
    folders: [folder.path],
    folderInfoByPath: { [folder.path]: folder },
    primaryPath: folder.path,
  });
  useWorktreeIntentStagingStore.getState().setIntent(stagingKey, {
    entries: [
      {
        kind: "local",
        workspacePath: folder.path,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  });
}

function expectForkWorkspaceCleared(): void {
  expect(useSeededWorkspaceSnapshotStore.getState().snapshotByKey).toEqual({});
  expect(useWorktreeIntentStagingStore.getState().intentByKey).toEqual({});
}

describe("D4: ChatForkDialog seeded from a tombstoned profile", () => {
  beforeEach(() => {
    dialogMocks.providersByClient.clear();
  });
  afterEach(() => {
    dialogMocks.createMutate.mockReset();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("forwards the selected Q&A checkpoint in the fork request", async () => {
    dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);
    renderDialog({
      ...forkTarget(null),
      interviewBlockId: "question-tool:interview",
      forkMode: "cross-question",
    });

    await submitFork();

    const [request] = dialogMocks.createMutate.mock.calls[0];
    expect(request).toEqual(
      expect.objectContaining({
        forkSource: {
          sourceChatId: "source-chat",
          assistantMessageId: "assistant-message-1",
          interviewBlockId: "question-tool:interview",
          carriedInterviews: "settled",
        },
      }),
    );
  });

  it("preserves live workspace edits after a failed attempt so retry submits the same snapshot", async () => {
    dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);
    const stagingKey = pendingForkChatStagingKey("epic-test");
    const folder = {
      path: "/repo/added-after-open",
      name: "added-after-open",
      repoIdentifier: null,
    };
    const stagedEntry = {
      kind: "worktree" as const,
      scripts: null,
      workspacePath: folder.path,
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new" as const,
        name: "traycer/retry",
        source: "main",
        carryUncommittedChanges: false,
      },
    };
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(stagingKey, {
      folders: [folder.path],
      folderInfoByPath: { [folder.path]: folder },
      primaryPath: folder.path,
    });
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, {
      entries: [stagedEntry],
    });
    renderDialog(forkTarget(null));

    await submitFork();

    expect(
      useSeededWorkspaceSnapshotStore.getState().snapshotByKey,
    ).not.toEqual({});
    expect(useWorktreeIntentStagingStore.getState().intentByKey).not.toEqual(
      {},
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => {
      expect(dialogMocks.createMutate).toHaveBeenCalledTimes(2);
    });
    const [firstRequest] = dialogMocks.createMutate.mock.calls[0];
    const [retryRequest] = dialogMocks.createMutate.mock.calls[1];
    expect(firstRequest).toEqual(
      expect.objectContaining({
        workspaceMode: "inherit",
        worktreeIntent: { entries: [stagedEntry] },
      }),
    );
    expect(retryRequest).toEqual(
      expect.objectContaining({
        workspaceMode: "inherit",
        worktreeIntent: { entries: [stagedEntry] },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useSeededWorkspaceSnapshotStore.getState().snapshotByKey).toEqual(
      {},
    );
    expect(useWorktreeIntentStagingStore.getState().intentByKey).toEqual({});
  });

  it("clears active ownership on controlled close and a later active fork on unmount", async () => {
    const target = forkTarget(null);
    const view = render(
      <ChatForkDialog
        open
        target={target}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    seedLiveForkWorkspace();

    view.rerender(
      <ChatForkDialog
        open={false}
        target={target}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    await waitFor(expectForkWorkspaceCleared);

    view.rerender(
      <ChatForkDialog
        open
        target={{ ...target, assistantMessageId: "assistant-message-later" }}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    seedLiveForkWorkspace();
    view.unmount();

    expectForkWorkspaceCleared();
  });

  it("clears active ownership when the controlled target changes", async () => {
    const target = forkTarget(null);
    const view = render(
      <ChatForkDialog
        open
        target={target}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    seedLiveForkWorkspace();

    view.rerender(
      <ChatForkDialog
        open
        target={{ ...target, assistantMessageId: "assistant-message-next" }}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );

    await waitFor(expectForkWorkspaceCleared);
  });

  it("does not let an inactive dialog clear another active fork in the same epic", () => {
    const inactive = render(
      <ChatForkDialog
        open={false}
        target={forkTarget(null)}
        epicId="epic-test"
        tabId="inactive-tab"
        onOpenChange={() => undefined}
      />,
    );
    const active = render(
      <ChatForkDialog
        open
        target={forkTarget(null)}
        epicId="epic-test"
        tabId="active-tab"
        onOpenChange={() => undefined}
      />,
    );
    seedLiveForkWorkspace();

    inactive.unmount();

    expect(
      useSeededWorkspaceSnapshotStore.getState().snapshotByKey,
    ).not.toEqual({});
    expect(useWorktreeIntentStagingStore.getState().intentByKey).not.toEqual(
      {},
    );

    active.unmount();
    expectForkWorkspaceCleared();
  });

  it("forking without touching the picker falls back to ambient when the source profile is tombstoned", async () => {
    dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);
    renderDialog(forkTarget("tombstoned-uuid"));

    await submitFork();

    const [request] = dialogMocks.createMutate.mock.calls[0];
    expect(request.settings?.profileId).toBeNull();
  });

  it("a source profile that is STILL alive passes through unchanged, and the dialog doesn't crash", async () => {
    dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
      claudeState([
        profile("ambient", "ambient", "Terminal account"),
        profile("work-uuid", "managed", "Work"),
      ]),
    ]);
    renderDialog(forkTarget("work-uuid"));

    await submitFork();

    const [request] = dialogMocks.createMutate.mock.calls[0];
    expect(request.settings?.profileId).toBe("work-uuid");
  });

  it("holds the seeded profileId verbatim while the tab host's providers.list hasn't loaded yet (unsettled)", async () => {
    // No entry registered for TAB_HOST_CLIENT at all - the `useHostQuery`
    // mock returns `data: undefined`, the genuine "still loading" signal
    // `resolveSeededProfileId`'s `settled` param must gate on.
    renderDialog(forkTarget("work-uuid"));

    await submitFork();

    const [request] = dialogMocks.createMutate.mock.calls[0];
    expect(request.settings?.profileId).toBe("work-uuid");
  });

  it("ticket 07: resolves the seeded profileId to ambient once the tab host SETTLES on an empty profiles[] (old host, or flag-off/unsupported provider)", async () => {
    // The tab's host HAS responded - just with no profiles for this
    // provider (an old host upgraded to `profiles: []`, or a new host with
    // the flag off / an unsupported provider). Per the protocol-schema-
    // contract-compat review's Major finding, preserving the pin here would
    // silently run the account on ambient while the UI/artifact still
    // claimed the managed profile - this must clear it instead.
    dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [claudeState([])]);
    renderDialog(forkTarget("work-uuid"));

    await submitFork();

    const [request] = dialogMocks.createMutate.mock.calls[0];
    expect(request.settings?.profileId).toBeNull();
  });

  describe("cross-host: validation must read the TAB host (useTabHostClient), never the active/decoy host", () => {
    it("source profile alive on the TAB host but absent on the decoy host must be PRESERVED (no false null)", async () => {
      dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
        claudeState([
          profile("ambient", "ambient", "Terminal account"),
          profile("work-uuid", "managed", "Work"),
        ]),
      ]);
      // A decoy "active host" claims the profile doesn't exist there. If the
      // dialog ever silently fell back to an app-wide active-host client
      // instead of `useTabHostClient()`, this would wrongly null the profile.
      dialogMocks.providersByClient.set(DECOY_ACTIVE_HOST_CLIENT, [
        claudeState([profile("ambient", "ambient", "Terminal account")]),
      ]);
      renderDialog(forkTarget("work-uuid"));

      await submitFork();

      const [request] = dialogMocks.createMutate.mock.calls[0];
      expect(request.settings?.profileId).toBe("work-uuid");
    });

    it("source profile tombstoned on the TAB host but alive on the decoy host must resolve to null", async () => {
      dialogMocks.providersByClient.set(TAB_HOST_CLIENT, [
        claudeState([profile("ambient", "ambient", "Terminal account")]),
      ]);
      // The decoy "active host" still has it alive. If the dialog ever
      // silently fell back to an app-wide active-host client, this would
      // wrongly preserve a dead id.
      dialogMocks.providersByClient.set(DECOY_ACTIVE_HOST_CLIENT, [
        claudeState([
          profile("ambient", "ambient", "Terminal account"),
          profile("work-uuid", "managed", "Work"),
        ]),
      ]);
      renderDialog(forkTarget("work-uuid"));

      await submitFork();

      const [request] = dialogMocks.createMutate.mock.calls[0];
      expect(request.settings?.profileId).toBeNull();
    });
  });
});
