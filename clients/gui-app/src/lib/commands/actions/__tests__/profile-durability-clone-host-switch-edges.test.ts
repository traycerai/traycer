import { describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
    profiles,
  };
}

function buildClient(
  hostId: string,
  providersListHandler: (() => { providers: ProviderCliState[] }) | null,
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
    status: "available",
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
    }));
    const targetClient = buildClient("target-host", () => ({
      providers: [claudeState([])],
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
    sourceHostId: "source-host",
    targetHostId: "target-host",
    directory: fakeDirectory([]),
    createChat: vi.fn<CreateChatCommand>(),
    sourceSettings: BASE_SETTINGS,
    globalClient: buildClient("global", () => ({ providers: [] })),
    onProfileFallbackToAmbient: vi.fn(),
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
        status: "available",
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
        status: "available",
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
        status: "available",
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

  it("the returned cancel function suppresses the deferred open even after the target resolves - no crash, no stray chat creation attempt beyond the one already dispatched", async () => {
    const createChat = vi.fn<CreateChatCommand>();
    const directory = fakeDirectory([
      {
        hostId: "target-host",
        label: "Target",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/target",
        version: "0.0.0-mock",
        status: "available",
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
