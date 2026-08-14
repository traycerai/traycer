import { describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { CreateChatCommand } from "@/lib/commands/actions/new-chat";
import {
  cloneChatOnHostSwitch,
  type CloneChatOnHostSwitchArgs,
} from "@/lib/commands/actions/clone-chat-on-host-switch";
import {
  mapProfileIdAcrossHosts,
  resolveClonedChatSettings,
} from "@/lib/commands/actions/resolve-cloned-chat-settings";
import { resolveCloneSourceOwnerUserId } from "@/hooks/chats/use-clone-source-owner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * D-series cross-host clone edges (durability audit): "target host with
 * empty profiles[] (flag off) and transient-client failure mid-mapping -
 * resolve-cloned-chat-settings must fall back to ambient + notice, never
 * throw unhandled."
 *
 * `resolve-cloned-chat-settings.test.ts` already adversarially covers most
 * of `resolveClonedChatSettings` in isolation (unreachable source, no
 * matching accountUuid, source-side RPC failure). This file adds the two
 * gaps that file doesn't: (1) an explicitly EMPTY target `profiles[]`
 * (mirrors ticket 04's documented "flag off -> profiles: []" contract, as
 * opposed to a non-empty array that merely lacks a match), a TARGET-side (not
 * source-side) RPC failure, and (2) the orchestrating
 * `cloneChatOnHostSwitch` itself - which had ZERO existing test coverage -
 * including the "target host isn't even in the directory" case that never
 * reaches `resolveClonedChatSettings` at all.
 */

const BASE_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: "source-work-uuid",
};

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  accountUuid: string | null,
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
    identity:
      accountUuid === null ? null : { email: null, tier: null, accountUuid },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
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
    profiles,
  };
}

function buildClient(
  hostId: string,
  providersListHandler:
    (() => { providers: ProviderCliState[]; native: null }) | null,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers:
        providersListHandler === null
          ? {}
          : { "providers.list": providersListHandler },
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

describe("resolveClonedChatSettings: additional adversarial edges", () => {
  it("falls back to ambient when the TARGET host has genuinely empty profiles[] (flag-off host), never throws", async () => {
    const sourceClient = buildClient("source-host", () => ({
      providers: [
        claudeState([profile("source-work-uuid", "managed", "Work", "acct-1")]),
      ],
      native: null,
    }));
    const targetClient = buildClient("target-host", () => ({
      providers: [claudeState([])],
      native: null,
    }));

    const result = await resolveClonedChatSettings({
      sourceSettings: BASE_SETTINGS,
      sourceClient,
      targetClient,
    });

    expect(result).toEqual({
      settings: { ...BASE_SETTINGS, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("falls back to ambient when the TARGET (not source) RPC call fails mid-mapping, never throws unhandled", async () => {
    const sourceClient = buildClient("source-host", () => ({
      providers: [
        claudeState([profile("source-work-uuid", "managed", "Work", "acct-1")]),
      ],
      native: null,
    }));
    // No handler registered on the target -> every request rejects, exactly
    // like a transient client failure reaching the host mid-mapping.
    const targetClient = buildClient("target-host", null);

    const result = await resolveClonedChatSettings({
      sourceSettings: BASE_SETTINGS,
      sourceClient,
      targetClient,
    });

    expect(result).toEqual({
      settings: { ...BASE_SETTINGS, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("mapProfileIdAcrossHosts treats a genuinely empty target array the same as no-match (not a crash / not a false match)", () => {
    expect(mapProfileIdAcrossHosts("acct-1", [])).toBeNull();
  });
});

function fakeDirectory(
  entries: readonly HostDirectoryEntry[],
): IHostDirectoryService {
  const byId = new Map(entries.map((entry) => [entry.hostId, entry]));
  return {
    list: () => Promise.resolve(entries),
    findById: (hostId) => byId.get(hostId) ?? null,
    refresh: () => Promise.resolve(entries),
    refreshForEra: () => Promise.resolve(entries),
    invalidateInFlightRefresh: () => undefined,
    getSelected: () => entries[0] ?? null,
    selectById: () => undefined,
    onSelectionChange: () => ({ dispose: () => undefined }),
  };
}

function baseCloneArgs(
  overrides: Partial<CloneChatOnHostSwitchArgs>,
): CloneChatOnHostSwitchArgs {
  return {
    epicId: "epic-1",
    tabId: "tab-1",
    sourceChatId: "source-chat-1",
    // Ticket 37: these edge cases are about orchestration, not the owner hint,
    // so they answer it the way a surface that does not know does.
    sourceOwnerUserId: null,
    sourceHostId: "source-host",
    targetHostId: "target-host",
    directory: fakeDirectory([]),
    createChat: vi.fn<CreateChatCommand>(),
    sourceSettings: BASE_SETTINGS,
    globalClient: buildClient("global", () => ({
      providers: [],
      native: null,
    })),
    onProfileFallbackToAmbient: vi.fn(),
    onHistoryUnavailable: vi.fn(),
    onCloneFailed: vi.fn(),
    navigateNestedFocus: null,
    ...overrides,
  };
}

describe("cloneChatOnHostSwitch: orchestration edges (previously untested)", () => {
  it("target host missing from the directory entirely: falls back to ambient, notifies the caller, never throws", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const onProfileFallbackToAmbient = vi.fn();
    const directory = fakeDirectory([
      {
        hostId: "source-host",
        label: "Source",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/source",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
      // target-host is deliberately absent - simulates it having gone
      // unreachable / been removed from the directory between offering the
      // clone action and the user confirming it.
    ]);

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory,
        createChat,
        onProfileFallbackToAmbient,
      }),
    );

    // Let the internal `resolveSettingsForClone().then(...)` microtask flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(onProfileFallbackToAmbient).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledTimes(1);
    const [request] = createChat.mock.calls[0];
    expect(request.settings).toEqual({ ...BASE_SETTINGS, profileId: null });
  });

  it("ambient source settings (profileId already null): no RPC calls at all, no fallback notice, settings pass through untouched", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const onProfileFallbackToAmbient = vi.fn();
    const ambientSettings: ChatRunSettings = {
      ...BASE_SETTINGS,
      profileId: null,
    };
    const directory = fakeDirectory([
      {
        hostId: "target-host",
        label: "Target",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/target",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
    ]);

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory,
        createChat,
        onProfileFallbackToAmbient,
        sourceSettings: ambientSettings,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(onProfileFallbackToAmbient).not.toHaveBeenCalled();
    expect(createChat).toHaveBeenCalledTimes(1);
    const [request] = createChat.mock.calls[0];
    expect(request.settings).toEqual(ambientSettings);
  });

  it("a null sourceSettings (chat that never ran) never crashes and creates the chat with host defaults", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const onProfileFallbackToAmbient = vi.fn();
    const directory = fakeDirectory([
      {
        hostId: "target-host",
        label: "Target",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/target",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
    ]);

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory,
        createChat,
        onProfileFallbackToAmbient,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(onProfileFallbackToAmbient).not.toHaveBeenCalled();
    expect(createChat).toHaveBeenCalledTimes(1);
    const [request] = createChat.mock.calls[0];
    expect(request.settings).toBeNull();
  });

  it("carries the owner the surface resolved into the outgoing request - the no-local-record, cloud-row-only clone (ticket 37)", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const directory = fakeDirectory([
      {
        hostId: "target-host",
        label: "Target",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/target",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
    ]);

    // What `useCloneSourceOwnerUserId` answers for a chat this device holds no
    // record of but whose cloud row it just rendered the tile from - the exact
    // case the host's cloud tier refused before this ticket, degrading the
    // clone to settings-only.
    const resolvedOwner = resolveCloneSourceOwnerUserId({
      chatId: "source-chat-1",
      localRecordOwnerUserId: null,
      cloudChats: [
        {
          identity: {
            taskId: "epic-1",
            chatId: "source-chat-1",
            ownerUserId: "owner-9",
          },
          ownerHostId: "owner-host",
          createdAt: 1,
          visibility: "task",
          title: null,
          isTitleEditedByUser: false,
          parentChatId: null,
          isArchived: false,
          runSettingsSummary: null,
          metadataUpdatedAt: 1,
          headSha256: null,
          publishedAt: null,
          throughRecordSeq: null,
          isOwnedByViewer: false,
        },
      ],
    });

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory,
        createChat,
        sourceSettings: null,
        sourceOwnerUserId: resolvedOwner,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(createChat).toHaveBeenCalledTimes(1);
    const [request] = createChat.mock.calls[0];
    expect(request.forkSource).toEqual({
      boundary: "latest",
      sourceChatId: "source-chat-1",
      sourceOwnerUserId: "owner-9",
    });
  });

  it("the returned cancel function suppresses the deferred open even after the target resolves - no crash, no stray chat creation attempt beyond the one already dispatched", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const directory = fakeDirectory([
      {
        hostId: "target-host",
        label: "Target",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/target",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      },
    ]);

    const cancel = cloneChatOnHostSwitch(
      baseCloneArgs({ directory, createChat, sourceSettings: null }),
    );
    // Cancel immediately, before the async profile-resolution microtask runs.
    cancel();
    cancel(); // idempotent - calling twice must not throw either.

    await Promise.resolve();
    await Promise.resolve();

    // Cancelling before resolution suppresses the deferred
    // `openNewChatInActiveTile` call entirely.
    expect(createChat).not.toHaveBeenCalled();
  });
});

// chat-sync-v2 ticket 34B1: the clone is a latest-checkpoint fork
// (`forkSource: {boundary: "latest"}`) of the source chat, not an empty
// chat. A source with no assistant turn yet has no checkpoint to fork
// through - the host answers that as a typed refusal, and this flow retries
// EXACTLY once without `forkSource` so the clone still lands.
describe("cloneChatOnHostSwitch: history-carrying fork and its retry", () => {
  const TARGET_DIRECTORY = fakeDirectory([
    {
      hostId: "target-host",
      label: "Target",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:0/target",
      version: "0.0.0-mock",
      transportDialability: "dialable",
    },
  ]);

  function checkpointUnavailableError(): HostRpcError {
    return new HostRpcError({
      code: "E_FORK_CHECKPOINT_UNAVAILABLE",
      message:
        "Cannot fork chat 'source-chat-1' because it has no assistant checkpoint yet.",
      requestId: "req-fork-1",
      method: "epic.createChat",
      fatalDetails: null,
    });
  }

  /**
   * The failure mode every released host produces for `boundary: "latest"`
   * today: the transport's same-major minor-downgrade cannot represent the
   * request against `epic.createChat@1.0` (no `assistantMessageId` to put in
   * the older schema's required field) and refuses BEFORE a frame is sent -
   * see `classifyHostRequestFailure`.
   */
  function downgradeUnsupportedError(): HostRpcError {
    return new HostRpcError({
      code: "DOWNGRADE_UNSUPPORTED",
      message: "epic.createChat request does not fit host version 1.0",
      requestId: "req-fork-downgrade",
      method: "epic.createChat",
      fatalDetails: null,
    });
  }

  it("sends a latest-checkpoint forkSource on the first attempt", async () => {
    const createChat = vi.fn<CreateChatCommand>();

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(createChat).toHaveBeenCalledTimes(1);
    const [request] = createChat.mock.calls[0];
    expect(request.forkSource).toEqual({
      boundary: "latest",
      sourceChatId: "source-chat-1",
      // `baseCloneArgs` is a surface that does not know the owner (ticket 37);
      // the request still states that explicitly rather than omitting it.
      sourceOwnerUserId: null,
    });
  });

  it("retries settings-only exactly once on a checkpoint-unavailable refusal, and reports it exactly once", async () => {
    const calls: unknown[] = [];
    const createChat: CreateChatCommand = (request, callbacks) => {
      calls.push(request.forkSource);
      if (request.forkSource !== null && request.forkSource !== undefined) {
        callbacks.onError(checkpointUnavailableError());
        return;
      }
      callbacks.onSuccess({ chatId: "cloned-chat" });
    };
    const onHistoryUnavailable = vi.fn();

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        onHistoryUnavailable,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Exactly two attempts - the fork attempt, then the settings-only
    // retry - never a third: the retry's own request carries no
    // `forkSource`, so it cannot produce this same refusal to retry on.
    expect(calls).toEqual([
      {
        boundary: "latest",
        sourceChatId: "source-chat-1",
        sourceOwnerUserId: null,
      },
      null,
    ]);
    expect(onHistoryUnavailable).toHaveBeenCalledTimes(1);
  });

  it("does not retry, and does not call onHistoryUnavailable, for an unrelated createChat failure - only onCloneFailed", async () => {
    const createChat = vi.fn<CreateChatCommand>((_request, callbacks) => {
      callbacks.onError(
        new HostRpcError({
          code: "RPC_ERROR",
          message: "host unreachable",
          requestId: "req-fork-2",
          method: "epic.createChat",
          fatalDetails: null,
        }),
      );
    });
    const onHistoryUnavailable = vi.fn();
    const onCloneFailed = vi.fn();

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        onHistoryUnavailable,
        onCloneFailed,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(onHistoryUnavailable).not.toHaveBeenCalled();
    expect(onCloneFailed).toHaveBeenCalledTimes(1);
  });

  // The blocker the cold review found: every released host is
  // `epic.createChat@1.0`-only, so the FIRST attempt against a real host
  // never even reaches the server - the client-side downgrade fails before
  // a frame is sent. Pre-B1 behavior always landed settings-only; this must
  // still be true post-B1.
  it("retries settings-only exactly once when the target host cannot receive a latest-checkpoint fork (DOWNGRADE_UNSUPPORTED)", async () => {
    const calls: unknown[] = [];
    const createChat: CreateChatCommand = (request, callbacks) => {
      calls.push(request.forkSource);
      if (request.forkSource !== null && request.forkSource !== undefined) {
        callbacks.onError(downgradeUnsupportedError());
        return;
      }
      callbacks.onSuccess({ chatId: "cloned-chat" });
    };
    const onHistoryUnavailable = vi.fn();
    const onCloneFailed = vi.fn();

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        onHistoryUnavailable,
        onCloneFailed,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      {
        boundary: "latest",
        sourceChatId: "source-chat-1",
        sourceOwnerUserId: null,
      },
      null,
    ]);
    expect(onHistoryUnavailable).toHaveBeenCalledTimes(1);
    expect(onHistoryUnavailable).toHaveBeenCalledWith("host-too-old");
    expect(onCloneFailed).not.toHaveBeenCalled();
  });

  it("calls onCloneFailed, not onHistoryUnavailable, when the settings-only retry itself fails", async () => {
    const createChat: CreateChatCommand = (request, callbacks) => {
      if (request.forkSource !== null && request.forkSource !== undefined) {
        callbacks.onError(checkpointUnavailableError());
        return;
      }
      // The retry (no forkSource) fails too, for an unrelated reason.
      callbacks.onError(
        new HostRpcError({
          code: "RPC_ERROR",
          message: "host unreachable",
          requestId: "req-fork-retry-fails",
          method: "epic.createChat",
          fatalDetails: null,
        }),
      );
    };
    const onHistoryUnavailable = vi.fn();
    const onCloneFailed = vi.fn();

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        onHistoryUnavailable,
        onCloneFailed,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onHistoryUnavailable).toHaveBeenCalledTimes(1);
    expect(onCloneFailed).toHaveBeenCalledTimes(1);
  });

  it("cancelling before the checkpoint-unavailable error arrives suppresses the toast and the retry", async () => {
    const deferred: { current: (() => void) | null } = { current: null };
    const createChat: CreateChatCommand = (request, callbacks) => {
      if (request.forkSource !== null && request.forkSource !== undefined) {
        // Deferred, not called synchronously - lets the test cancel BEFORE
        // the error arrives, the exact race the guard exists for.
        deferred.current = () =>
          callbacks.onError(checkpointUnavailableError());
        return;
      }
      callbacks.onSuccess({ chatId: "cloned-chat" });
    };
    const onHistoryUnavailable = vi.fn();

    const cancel = cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        onHistoryUnavailable,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    cancel();
    deferred.current?.();

    expect(onHistoryUnavailable).not.toHaveBeenCalled();
  });

  it("reports include_history: true for a fork that succeeds without a retry", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const createChat: CreateChatCommand = (_request, callbacks) => {
      callbacks.onSuccess({ chatId: "cloned-chat" });
    };

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.ChatForked,
      expect.objectContaining({ include_history: true }),
    );
    track.mockRestore();
  });

  it("reports include_history: false for the settings-only retry that followed a checkpoint-unavailable refusal", async () => {
    // The flag must reflect what the REQUEST that actually succeeded sent,
    // not the flow's original intent - the retry carries no `forkSource`, so
    // no history came along, and `include_history: true` here would be a
    // known-false analytics value on the exact path ticket 34B1 built.
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const createChat: CreateChatCommand = (request, callbacks) => {
      if (request.forkSource !== null && request.forkSource !== undefined) {
        callbacks.onError(checkpointUnavailableError());
        return;
      }
      callbacks.onSuccess({ chatId: "cloned-chat" });
    };

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: TARGET_DIRECTORY,
        createChat,
        sourceSettings: null,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.ChatForked,
      expect.objectContaining({ include_history: false }),
    );
    track.mockRestore();
  });

  it("a settings resolution that REJECTS ends the flow through onCloneFailed, never silently", async () => {
    // `resolveClonedChatSettings` itself never throws, so this covers the
    // seams around it (a directory lookup, transient-client construction)
    // rejecting - without the catch arm the flow just stopped, leaving the
    // caller's "cloning…" state pending forever with no clone and no
    // terminal signal.
    const createChat = vi.fn<CreateChatCommand>();
    const onCloneFailed = vi.fn();
    const throwingDirectory: IHostDirectoryService = {
      ...fakeDirectory([]),
      findById: () => {
        throw new Error("directory backend gone");
      },
    };

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: throwingDirectory,
        createChat,
        onCloneFailed,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(createChat).not.toHaveBeenCalled();
    expect(onCloneFailed).toHaveBeenCalledTimes(1);
  });

  it("a selection that MOVED while settings resolved fails the clone instead of creating on the wrong host", async () => {
    // The create mutation stamps the ACTIVE host at mutate time. A user who
    // moves the active host mid-resolution (from a surface that never cancels
    // this flow) must get a failed clone, not a chat created on the moved-to
    // host under an open intent that names the original target.
    const createChat = vi.fn<CreateChatCommand>();
    const onCloneFailed = vi.fn();
    const targetEntry: HostDirectoryEntry = {
      hostId: "target-host",
      label: "Target",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:0/target",
      version: "0.0.0-mock",
      transportDialability: "dialable",
    };
    const movedToEntry: HostDirectoryEntry = {
      hostId: "third-host",
      label: "Third",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:0/third",
      version: "0.0.0-mock",
      transportDialability: "dialable",
    };
    const selected = { current: targetEntry };
    const movingDirectory: IHostDirectoryService = {
      ...fakeDirectory([targetEntry, movedToEntry]),
      getSelected: () => selected.current,
    };

    cloneChatOnHostSwitch(
      baseCloneArgs({
        directory: movingDirectory,
        createChat,
        onCloneFailed,
        sourceSettings: null,
      }),
    );
    // The move lands while `resolveSettingsForClone`'s microtask is pending.
    selected.current = movedToEntry;

    await Promise.resolve();
    await Promise.resolve();

    expect(createChat).not.toHaveBeenCalled();
    expect(onCloneFailed).toHaveBeenCalledTimes(1);
  });
});
