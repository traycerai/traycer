import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  downgradeProviderCliStateToV10,
  providerCliStateSchema,
  providerCliStateSchemaV10,
  providerCliStateSchemaV20,
  providerProfileActionSchema,
  providersSetEnabledRequestSchemaV21,
} from "@traycer/protocol/host/provider-schemas";
// Importing from the registry runs `defineVersionedRpcRegistry` (full
// structural + schema-compatibility validation) at module load, so this
// import alone asserts the new `providers.startLogin@1.1` /
// `providers.setEnabled@2.1` lines and their bridges are well-formed.
import {
  providersAwaitLoginDowngradeV2ToV1,
  providersSetEnabledDowngradeV2ToV1,
} from "@traycer/protocol/host/registry";
import { prepareTuiLaunchRequestSchema } from "@traycer/protocol/host/agent/tui/unary-schemas";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  grokChatSessionAnchorSchema,
  claudeChatSessionAnchorSchema,
} from "@traycer/protocol/persistence/epic/senders";
import { claudeTuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

/**
 * Multi-profile protocol ticket coverage: every additive field parses old
 * (pre-profile) persisted shapes with `profileId`/`labelSnapshot`/
 * `accountUuid` defaulting to null, and every downgrade bridge that targets a
 * frozen/strict pre-profile wire shape strips the new fields instead of
 * failing the parse.
 */

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
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
  };
}

const sessionWorkspaceSnapshot = {
  workspaceKind: "session-snapshot" as const,
  primaryWorkspace: "/repo",
};

describe("legacy (pre-profile) persisted artifacts parse with profile defaults", () => {
  it("chatRunSettingsSchema defaults profileId to null", () => {
    const legacy = {
      harnessId: "claude",
      model: "claude-opus-4",
      permissionMode: "supervised",
      reasoningEffort: null,
      agentMode: "regular",
    };
    const parsed = chatRunSettingsSchema.parse(legacy);
    expect(parsed.profileId).toBeNull();
  });

  it("baseTuiAgentFields (via claudeTuiAgentSchema) defaults profileId to null", () => {
    const legacy = {
      harnessId: "claude",
      id: "agent-1",
      parentId: null,
      title: "",
      isTitleEditedByUser: false,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-1",
      userId: "user-1",
      workspaceFolders: [],
      model: null,
      agentMode: "regular",
      harnessSessionId: "session-1",
    };
    const parsed = claudeTuiAgentSchema.parse(legacy);
    expect(parsed.profileId).toBeNull();
  });

  it("prepareTuiLaunchRequestSchema defaults profileId to null", () => {
    const legacy = {
      harnessId: "codex",
      epicId: "epic-1",
      model: null,
      agentMode: "regular",
      tuiAgentId: "agent-1",
      harnessSessionId: null,
    };
    const parsed = prepareTuiLaunchRequestSchema.parse(legacy);
    expect(parsed.profileId).toBeNull();
  });

  it("chatSessionAnchorSchema variants default profileId/labelSnapshot/accountUuid to null", () => {
    const legacyClaudeAnchor = {
      harnessId: "claude",
      hostId: "host-1",
      sessionId: "session-1",
      sessionWorkspaceSnapshot,
      claudeMessageUuid: "uuid-1",
      createdAt: 0,
    };
    const parsedClaude = claudeChatSessionAnchorSchema.parse(legacyClaudeAnchor);
    expect(parsedClaude.profileId).toBeNull();
    expect(parsedClaude.labelSnapshot).toBeNull();
    expect(parsedClaude.accountUuid).toBeNull();

    // Grok has no discriminating field beyond the shared shape - covers the
    // eight ACP-style anchors that share this exact structure.
    const legacyGrokAnchor = {
      harnessId: "grok",
      hostId: "host-1",
      sessionId: "session-1",
      sessionWorkspaceSnapshot,
      createdAt: 0,
    };
    const parsedGrok = grokChatSessionAnchorSchema.parse(legacyGrokAnchor);
    expect(parsedGrok.profileId).toBeNull();
    expect(parsedGrok.labelSnapshot).toBeNull();
    expect(parsedGrok.accountUuid).toBeNull();
  });
});

describe("ProviderCliState.profiles[] downgrade to v1.0", () => {
  it("strips profiles (and availabilityPending) before the strict v1.0 parse", () => {
    const state = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      profiles: [
        {
          profileId: "profile-1",
          kind: "managed" as const,
          authType: "oauth" as const,
          label: "Work",
          auth: {
            status: "authenticated" as const,
            badgeText: null,
            label: null,
            detail: null,
          },
          identity: {
            email: "work@example.com",
            tier: "max",
            accountUuid: "uuid-1",
          },
          usageUpdatedAt: 1735689600000,
          duplicateOfProfileId: "profile-0",
          ambientDriftNotice: {
            previousEmail: "alice@example.com",
            changedAt: 1735689600000,
          },
        },
      ],
    });
    expect(state.profiles).toHaveLength(1);

    const downgraded = downgradeProviderCliStateToV10(state);
    expect(downgraded).not.toBeNull();
    // `providerCliStateSchemaV10` is a strict object - re-parsing the
    // downgraded value proves no profile/identity data survived (a strict
    // parse would reject any leftover unknown key).
    expect(providerCliStateSchemaV10.safeParse(downgraded).success).toBe(true);
    expect(downgraded).not.toHaveProperty("profiles");
    expect(JSON.stringify(downgraded)).not.toContain("alice@example.com");
  });

  it("still downgrades a provider with no profiles[] (old host build)", () => {
    const state = providerCliStateSchema.parse(providerState("codex"));
    const downgraded = downgradeProviderCliStateToV10(state);
    expect(downgraded).not.toBeNull();
    expect(downgraded).not.toHaveProperty("profiles");
  });

  it("defaults duplicateOfProfileId and ambientDriftNotice to null when omitted", () => {
    const state = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      profiles: [
        {
          profileId: "profile-1",
          kind: "ambient" as const,
          authType: "oauth" as const,
          label: "Terminal account",
          auth: {
            status: "authenticated" as const,
            badgeText: null,
            label: null,
            detail: null,
          },
          identity: null,
          usageUpdatedAt: null,
          // duplicateOfProfileId / ambientDriftNotice deliberately omitted -
          // covers a host build that predates these two fields.
        },
      ],
    });
    expect(state.profiles[0].duplicateOfProfileId).toBeNull();
    expect(state.profiles[0].ambientDriftNotice).toBeNull();
  });

  it("degrades an out-of-palette reusedTombstone.accentColor to null without dropping the profile or the profiles array", () => {
    const state = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      profiles: [
        {
          profileId: "profile-1",
          kind: "managed" as const,
          authType: "oauth" as const,
          label: "Work",
          auth: {
            status: "authenticated" as const,
            badgeText: null,
            label: null,
            detail: null,
          },
          identity: null,
          usageUpdatedAt: null,
          // A newer host's palette grew a color this client's frozen enum
          // doesn't know about - the array-level `.catch([])` on `profiles`
          // would otherwise silently wipe every profile for this provider.
          reusedTombstone: { label: "Old Work", accentColor: "#ffffff" },
        },
      ],
    });
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].reusedTombstone).toEqual({
      label: "Old Work",
      accentColor: null,
    });
  });
});

describe("providers.list v3.0 -> v2.0 downgrade strips profiles[]", () => {
  const stateWithProfile = providerCliStateSchema.parse({
    ...providerState("claude-code"),
    profiles: [
      {
        profileId: "profile-1",
        kind: "managed" as const,
        authType: "oauth" as const,
        label: "Work",
        auth: {
          status: "authenticated" as const,
          badgeText: null,
          label: null,
          detail: null,
        },
        identity: {
          email: "work@example.com",
          tier: "max",
          accountUuid: "uuid-1",
        },
        usageUpdatedAt: 1735689600000,
        duplicateOfProfileId: "profile-0",
        ambientDriftNotice: {
          previousEmail: "alice@example.com",
          changedAt: 1735689600000,
        },
      },
    ],
  });

  it("providerCliStateSchemaV20 drops an unmodeled profiles key on parse", () => {
    // Regression guard for the leak this frozen schema used to have: it was
    // defined via `.extend()` on the live (growing) schema, so it silently
    // inherited `profiles` instead of staying pinned to what v2.0 shipped.
    const parsed = providerCliStateSchemaV20.parse(stateWithProfile);
    expect(parsed).not.toHaveProperty("profiles");
  });

  it("downgradeProviderCliStateListToV20 never leaks profile identity to a v2.0 caller", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      3,
      2,
      { providers: [stateWithProfile] },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty("profiles");
    // Belt-and-suspenders: prove the email itself (both the live identity
    // and the ambient-drift notice's previous email) is gone from the wire
    // value, not just hidden behind the schema's field list.
    const serialized = JSON.stringify(downgraded.value);
    expect(serialized).not.toContain("work@example.com");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("profile-0");
  });
});

describe("providers.startLogin@1.1 (create profile / re-login to a profile)", () => {
  it("upgrades a v1.0 request/response to v1.1 with profile fields defaulted to null", () => {
    const upgradedRequest = upgradeRequestToVersion(
      hostRpcRegistry["providers.startLogin"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      { providerId: "claude-code" },
    );
    expect(upgradedRequest).toEqual({
      providerId: "claude-code",
      profileId: null,
      createProfile: null,
    });

    const upgradedResponse = upgradeResponseToVersion(
      hostRpcRegistry["providers.startLogin"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      { url: null, started: true },
    );
    expect(upgradedResponse).toEqual({
      url: null,
      started: true,
      profileId: null,
    });
  });
});

describe("providers.awaitLogin v2->v1 downgrade strips profileId", () => {
  it("drops profileId before the strict v1.0 request parse", () => {
    const downgraded = providersAwaitLoginDowngradeV2ToV1.downgradeRequest({
      providerId: "claude-code",
      profileId: "profile-1",
    });
    expect(downgraded).toEqual({
      ok: true,
      value: { providerId: "claude-code" },
    });
  });

  it("round-trips through the registry (major 2 -> major 1)", () => {
    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.awaitLogin"],
      2,
      1,
      { providerId: "codex", profileId: "profile-1" },
    );
    expect(downgraded).toEqual({ ok: true, value: { providerId: "codex" } });
  });
});

describe("providers.setEnabled@2.1 (profile rename/remove/recolor)", () => {
  it("upgrades a v2.0 request to v2.1 with profileAction defaulted to null", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["providers.setEnabled"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      { providerId: "claude-code", enabled: true },
    );
    expect(upgraded).toEqual({
      providerId: "claude-code",
      enabled: true,
      profileAction: null,
    });
  });

  it("accepts recolor only with a palette accent color", () => {
    expect(
      providerProfileActionSchema.safeParse({
        type: "recolor",
        profileId: "profile-1",
        accentColor: "#14b8a6",
      }).success,
    ).toBe(true);
    expect(
      providerProfileActionSchema.safeParse({
        type: "recolor",
        profileId: "profile-1",
        accentColor: "#ffffff",
      }).success,
    ).toBe(false);
  });

  it("drops profileAction before the strict v1.0 request parse", () => {
    const rename = providersSetEnabledDowngradeV2ToV1.downgradeRequest({
      providerId: "claude-code",
      enabled: true,
      profileAction: { type: "rename", profileId: "profile-1", label: "Work" },
    });
    expect(rename).toEqual({
      ok: true,
      value: { providerId: "claude-code", enabled: true },
    });

    const remove = providersSetEnabledDowngradeV2ToV1.downgradeRequest({
      providerId: "claude-code",
      enabled: true,
      profileAction: { type: "remove", profileId: "profile-1" },
    });
    expect(remove).toEqual({
      ok: true,
      value: { providerId: "claude-code", enabled: true },
    });

    const recolor = providersSetEnabledDowngradeV2ToV1.downgradeRequest({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "recolor",
        profileId: "profile-1",
        accentColor: "#14b8a6",
      },
    });
    expect(recolor).toEqual({
      ok: true,
      value: { providerId: "claude-code", enabled: true },
    });
  });

  it("round-trips a plain (no profileAction) v1.0 request through the full major 2 -> major 1 downgrade", () => {
    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.setEnabled"],
      2,
      1,
      { providerId: "codex", enabled: false, profileAction: null },
    );
    expect(downgraded).toEqual({
      ok: true,
      value: { providerId: "codex", enabled: false },
    });
  });
});

describe("acknowledgeAmbientDrift profileAction (rides the unreleased @2.1)", () => {
  // No frozen-@2.1 rejection case and no @2.1->@2.2 upgrade case here on
  // purpose: `acknowledgeAmbientDrift` widened the SAME unreleased `@2.1`
  // union the other profileActions ride (the released surface, host-v1.0.0,
  // negotiates `providers.setEnabled@2.0`), so there is no older @2.x peer
  // schema to freeze against - the @2.0/@1.0 cases above already cover every
  // released-peer path.
  it("the @2.1 request schema accepts acknowledgeAmbientDrift with no profileId", () => {
    expect(
      providersSetEnabledRequestSchemaV21.safeParse({
        providerId: "claude-code",
        enabled: true,
        profileAction: { type: "acknowledgeAmbientDrift" },
      }).success,
    ).toBe(true);
    expect(
      providerProfileActionSchema.safeParse({
        type: "acknowledgeAmbientDrift",
      }).success,
    ).toBe(true);
  });

  it("drops profileAction (acknowledgeAmbientDrift included) before the strict v1.0 request parse, same as rename/remove/recolor", () => {
    const downgraded = providersSetEnabledDowngradeV2ToV1.downgradeRequest({
      providerId: "claude-code",
      enabled: true,
      profileAction: { type: "acknowledgeAmbientDrift" },
    });
    expect(downgraded).toEqual({
      ok: true,
      value: { providerId: "claude-code", enabled: true },
    });
  });

  it("round-trips an acknowledgeAmbientDrift request through the full major 2 -> major 1 downgrade", () => {
    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.setEnabled"],
      2,
      1,
      {
        providerId: "codex",
        enabled: true,
        profileAction: { type: "acknowledgeAmbientDrift" },
      },
    );
    expect(downgraded).toEqual({
      ok: true,
      value: { providerId: "codex", enabled: true },
    });
  });
});
