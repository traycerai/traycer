import { beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
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
  identityId: null,
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

/**
 * Record the target host's negotiated catalog line so it can PROVE it knows
 * `auto`.
 *
 * The clamp now takes two proofs - the target ROW's constraint and the target
 * HOST's line - because an unconstrained row on a pre-`auto` host says nothing
 * about the wire. Without this the registry answers `null`, which reads as
 * "cannot spell it" and demotes, which is the safe direction and exactly what
 * the sibling cases below assert.
 */
function targetHostKnowsAutoMode(): void {
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
    "agent.gui.listHarnesses": agentGuiListHarnessesV91.schemaVersion,
  });
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
  beforeEach(() => {
    resetNegotiatedManifests();
  });

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
  // The negotiated-manifest registry is module-level state, so a
  // `targetHostKnowsAutoMode()` call earlier in this describe block would
  // otherwise leak into every later test that never calls it itself - a
  // false pass hiding behind an untested reliance on execution order. Mirrors
  // the sibling `describe`'s own `beforeEach` above.
  beforeEach(() => {
    resetNegotiatedManifests();
  });

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
    targetHostKnowsAutoMode();
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
    targetHostKnowsAutoMode();
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

  // FIX 2 (P1): the sibling of the case above, WITHOUT
  // `targetHostKnowsAutoMode()`. The row is exactly as unconstrained - an
  // empty `supportedPermissionModes` `harnessHonorsPermissionMode` treats
  // identically either way - so the only thing that differs is the target
  // HOST's own negotiated line, which this test leaves unrecorded (the
  // `beforeEach` above resets it). A pre-`auto` host serves unconstrained
  // rows like any other, so before this fix the clone would have kept `auto`
  // on a machine whose wire cannot carry it; the safe direction is to demote,
  // exactly as the "no target catalog anywhere" case at the top of this
  // describe block does.
  it("demotes auto when the target row declares an empty supportedPermissionModes but no manifest proves the target host knows auto", async () => {
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
      settings: { ...autoSourceSettings, permissionMode: "auto_accept_edits" },
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

// FIX 1 (P1): the demotion chain used to be applied ONE step and unchecked -
// `auto` became `auto_accept_edits` on a `["full_access"]` row and went to
// `epic.createChat` as a tuple that host refuses outright. Now every rung of
// `demotionChain()` is checked against the target row in turn, and only when
// NONE fit does the clone refuse with `permission-mode-unsupported` instead
// of sending an unsupported tuple.
describe("resolveClonedChatSettings refuses when no rung of the demotion chain fits, and never widens past auto", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  const autoSourceSettings: ChatRunSettings = {
    ...BASE_SETTINGS,
    permissionMode: "auto",
  };

  // 1a: neither `auto` nor its fallback `auto_accept_edits` fits the target
  // row - the refusal, with both attempted modes named in the order tried.
  it("refuses with permission-mode-unsupported when the target row supports neither auto nor its fallback", async () => {
    targetHostKnowsAutoMode();
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "claude",
          supportedPermissionModes: ["full_access"],
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
      status: "permission-mode-unsupported",
      harnessId: "claude",
      attemptedModes: ["auto", "auto_accept_edits"],
    });
  });

  // 1c: the FIRST rung (auto itself) already fits, so the walk must return
  // the settings object it was HANDED rather than a freshly-spread copy -
  // the `candidate === settings.permissionMode ? settings : ...` branch this
  // pins is what makes every untouched clone reference-stable.
  it("returns the exact settings object, unchanged, when the target row already supports auto", async () => {
    targetHostKnowsAutoMode();
    const sourceClient = buildClient([], []);
    const targetClient = buildClient(
      [profile("ambient", "ambient", "Terminal account", "acct-9")],
      [
        harnessOption({
          id: "claude",
          supportedPermissionModes: ["auto", "full_access"],
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
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.settings).toBe(autoSourceSettings);
  });

  // 1d: a non-`auto` source mode must never enter this clamp at all, even
  // against a target row that would reject it outright - pins that the fix
  // did not accidentally widen the walk to every mode. Mirrors the sibling
  // early-return case above, but names the rejecting row explicitly and
  // proves the catalog was never even consulted.
  it("never widens the clamp to a non-auto mode, even against a target row that would reject it", async () => {
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
            return {
              harnesses: [
                harnessOption({
                  id: "claude",
                  supportedPermissionModes: ["full_access"],
                }),
              ],
            };
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
