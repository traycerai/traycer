import { describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type GuiHarnessOption,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { resolveClonedChatSettings } from "../resolve-cloned-chat-settings";

const BASE_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  account:
    | string
    | null
    | { readonly accountUuid: string | null; readonly enabled: boolean },
): ProviderProfile {
  const accountUuid =
    typeof account === "object" && account !== null
      ? account.accountUuid
      : account;
  const enabled =
    typeof account === "object" && account !== null ? account.enabled : true;
  return {
    profileId,
    enabled,
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

function harnessOption(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

// `harnesses: null` means no `agent.gui.listHarnesses` handler is registered
// at all, so a call to it REJECTS - the same "absent handler" convention
// `profiles: null` already uses for `providers.list` below. Every existing
// call site passes `[]` because its `sourceSettings.permissionMode` is
// "supervised", not "auto" - `permissionModeForTarget` short-circuits before
// ever requesting the catalog, so the harnesses fixture is inert there.
function buildClient(
  profiles: ProviderProfile[] | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | null,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        ...(profiles === null
          ? {}
          : {
              "providers.list": () => ({
                providers: [claudeState(profiles)],
                native: null,
              }),
            }),
        ...(harnesses === null
          ? {}
          : {
              // A fresh array: the response type is mutable, the fixture is
              // readonly, and vitest would never have said so.
              "agent.gui.listHarnesses": () => ({ harnesses: [...harnesses] }),
            }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

describe("resolveClonedChatSettings", () => {
  it("passes ambient settings through untouched when Terminal is enabled", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: BASE_SETTINGS,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: BASE_SETTINGS,
      fallenBackToAmbient: false,
    });
  });

  it("maps the source profile to the target's matching profile by accountUuid", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient(
      [profile("source-work-uuid", "managed", "Work", "acct-1")],
      [],
    );
    const targetClient = buildClient(
      [
        profile("ambient", "ambient", "Terminal account", "acct-9"),
        profile("target-work-uuid", "managed", "Work", "acct-1"),
      ],
      [],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: "target-work-uuid" },
      fallenBackToAmbient: false,
    });
  });

  it("requires profile selection when the identity match on the target is disabled", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient(
      [profile("source-work-uuid", "managed", "Work", "acct-1")],
      [],
    );
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", {
        accountUuid: "acct-1",
        enabled: false,
      }),
    ];
    const targetClient = buildClient(targetProfiles, []);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "matching-profile-disabled",
      matchedProfileId: "target-work-uuid",
      targetProfiles,
    });
  });

  it("returns ready for an explicitly selected enabled target profile", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ];
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient: null,
      targetClient: buildClient(targetProfiles, []),
      explicitTargetProfileId: { profileId: "target-work-uuid" },
    });

    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: "target-work-uuid" },
      fallenBackToAmbient: false,
    });
  });

  it("reports when an explicitly selected profile disappeared from the target", async () => {
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ];
    const result = await resolveClonedChatSettings({
      sourceSettings: { ...BASE_SETTINGS, profileId: "source-work-uuid" },
      sourceClient: null,
      targetClient: buildClient(targetProfiles, []),
      explicitTargetProfileId: { profileId: "vanished-profile" },
    });

    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "explicit-profile-missing",
      matchedProfileId: "vanished-profile",
      targetProfiles,
    });
  });

  it("falls back to ambient when the source host is unreachable (null client)", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const targetClient = buildClient(
      [
        profile("ambient", "ambient", "Terminal account", "acct-9"),
        profile("target-work-uuid", "managed", "Work", "acct-1"),
      ],
      [],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient: null,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("falls back to Terminal when no identity matches and Terminal is enabled", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient(
      [profile("source-work-uuid", "managed", "Work", "acct-1")],
      [],
    );
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("requires profile selection when no eligible Terminal fallback exists", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient(
      [profile("source-work-uuid", "managed", "Work", null)],
      [],
    );
    const targetClient = buildClient(
      [profile("target-work-uuid", "managed", "Work", "acct-1")],
      [],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "no-enabled-terminal-fallback",
      matchedProfileId: null,
      targetProfiles: [
        profile("target-work-uuid", "managed", "Work", "acct-1"),
      ],
    });
  });

  it("distinguishes target catalog transport failure from an empty catalog", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    // The source may be unavailable; the target catalog failure is the
    // recovery state this regression distinguishes from an honest empty list.
    const sourceClient = buildClient(null, []);
    const targetClient = buildClient(null, []);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "catalog-unavailable",
      providerId: "claude-code",
    });
  });
});

// JOB 3 (Codex ivFes, P1): `permissionModeForTarget` runs before the profile
// remap, clamping `auto` against the TARGET's own harness catalog rather than
// letting it ride through to a create the target host would refuse outright.
describe("resolveClonedChatSettings clamps auto against the target catalog", () => {
  const autoSourceSettings: ChatRunSettings = {
    ...BASE_SETTINGS,
    permissionMode: "auto",
  };

  // The defect: an `auto` source chat cloned onto a host with no `auto`
  // harness used to carry the mode through verbatim, and the target's own
  // `epic.createChat` would reject the whole clone rather than accept a mode
  // it cannot honor.
  it("demotes auto to auto_accept_edits when the target catalog offers no auto harness anywhere", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "claude",
          supportedPermissionModes: ["supervised", "auto_accept_edits"],
        }),
      ],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: { ...autoSourceSettings, permissionMode: "auto_accept_edits" },
      fallenBackToAmbient: false,
    });
  });

  // The question is about ONE row - the one `settings.harnessId` names. This
  // case used to hold a MIXED catalog (claude without `auto`, codex with it)
  // and assert that `auto` survived, on the reading that "at least one target
  // harness supports it". That reading was wrong, and it was wrong in the
  // direction the whole function exists to prevent: the clone runs `claude`,
  // the host judges the tuple against `claude` alone, and the create it would
  // have produced fails on the target for exactly the mode this clamp is
  // supposed to have already settled. The sibling case below covers the mixed
  // catalog under the correct assertion; this one keeps the POSITIVE path
  // honest by letting the target row itself offer `auto`.
  it("keeps auto when the target row named by settings.harnessId supports it", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "claude",
          supportedPermissionModes: ["supervised", "auto", "full_access"],
        }),
        harnessOption({
          id: "codex",
          supportedPermissionModes: ["supervised", "auto_accept_edits"],
        }),
      ],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: autoSourceSettings,
      fallenBackToAmbient: false,
    });
  });

  // A failed read is not evidence of anything - the sibling `providers.list`
  // failure one field over is likewise surfaced as the retryable
  // `catalog-unavailable`, never treated as proof the target has no profiles.
  // Guessing "no auto" from a transient `agent.gui.listHarnesses` failure
  // would silently demote a durable setting on a blip the user could have
  // just retried past.
  it("keeps auto when the target harness-catalog read rejects, rather than guessing at a demotion", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      null,
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: autoSourceSettings,
      fallenBackToAmbient: false,
    });
  });

  // THE REGRESSION this ticket exists for: `permissionModeForTarget` used to
  // read the target row with a bare `targetRow.supportedPermissionModes
  // .includes("auto")`. An EMPTY array is a harness that answered and
  // declared no constraint (the host's own
  // `HarnessRuntime.assertAdapterPermissionModeSupported` short-circuits on
  // it), so a bare `.includes` read it as "no auto here" and silently
  // demoted a mode the target would have accepted. The fix routes through
  // `harnessHonorsPermissionMode`, which treats `[]` like `null`.
  it("keeps auto when the target row named by settings.harnessId declares an empty supportedPermissionModes", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [harnessOption({ id: "claude", supportedPermissionModes: [] })],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: autoSourceSettings,
      fallenBackToAmbient: false,
    });
  });

  // JOB 2 (Codex, P1): the sibling of the case above, under the MIXED
  // catalog that used to be asserted the other way. `settings.harnessId` is
  // `claude`, and the target's `claude` row offers no `auto` - the presence
  // of `codex`'s `auto` elsewhere in the catalog is not evidence about the
  // row this chat will actually run on. `assertPermissionModeSupported` on
  // the host judges the tuple `(harnessId: "claude", permissionMode: "auto")`
  // against the `claude` row alone, so surviving this clamp on the strength
  // of `codex`'s row would still fail the create on the target - the exact
  // failure this function exists to pre-empt.
  it("demotes auto when settings.harnessId's own row lacks it, even though another target harness offers it", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "claude",
          supportedPermissionModes: ["supervised", "auto_accept_edits"],
        }),
        harnessOption({
          id: "codex",
          supportedPermissionModes: ["supervised", "auto"],
        }),
      ],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: { ...autoSourceSettings, permissionMode: "auto_accept_edits" },
      fallenBackToAmbient: false,
    });
  });

  // The target catalog has no row at all for `settings.harnessId`. No row is
  // not positive evidence about the MODE - clamping here would rewrite a
  // durable setting on the way to a create that fails for the honest,
  // different reason that the target lacks the harness entirely. Settings
  // must pass through unchanged so the create's own error names that reason.
  it("leaves settings unchanged when the target catalog has no row for settings.harnessId at all", async () => {
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "codex",
          supportedPermissionModes: ["supervised", "auto"],
        }),
      ],
    );
    const result = await resolveClonedChatSettings({
      sourceSettings: autoSourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: autoSourceSettings,
      fallenBackToAmbient: false,
    });
  });

  // The early return: a non-`auto` source mode has nothing to clamp, and
  // reading the target's catalog for it would be a wasted round trip on every
  // ordinary (non-Auto-mode) clone.
  it("does not touch a non-auto mode, and never requests the target's harness catalog for it", async () => {
    const requestedMethods: string[] = [];
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => {} },
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "providers.list": () => ({
            providers: [
              claudeState([
                profile("ambient", "ambient", "Terminal account", "acct-9"),
              ]),
            ],
            native: null,
          }),
          "agent.gui.listHarnesses": () => {
            requestedMethods.push("agent.gui.listHarnesses");
            return { harnesses: [] };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const targetClient = spine.createRequester(mockLocalHostEntry);
    const supervisedSourceSettings: ChatRunSettings = {
      ...BASE_SETTINGS,
      permissionMode: "supervised",
    };

    const result = await resolveClonedChatSettings({
      sourceSettings: supervisedSourceSettings,
      sourceClient: buildClient([], []),
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "ready",
      settings: supervisedSourceSettings,
      fallenBackToAmbient: false,
    });
    expect(requestedMethods).toEqual([]);
  });
});
