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
  providersListRequestSchema,
  providersListResponseSchema,
  providerCliStateSchema,
  providerCliStateSchemaV10,
  providerCliStateSchemaV20,
  providerCliStateSchemaV30,
  providerMutationCliStateSchemaV20,
  providerMutationCliStateSchemaV21,
  providerProfileActionSchema,
  providerProfileSchema,
  providerProfileSchemaV80,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV80,
  providersListResponseSchemaV70,
  providersListResponseSchemaV60,
  providersListResponseSchemaV50,
  providersListResponseSchemaV40,
  providersListResponseSchemaV10,
  providersSetEnabledRequestSchemaV21,
} from "@traycer/protocol/host/provider-schemas";
// Importing from the registry runs `defineVersionedRpcRegistry` (full
// structural + schema-compatibility validation) at module load, so this
// import alone asserts the new `providers.startLogin@1.1` /
// `providers.setEnabled@2.1` lines and their bridges are well-formed.
import {
  providersAwaitLoginDowngradeV21ToV10,
  providersSetEnabledDowngradeV2ToV1,
  providersStartLoginUpgradeV11ToV12,
  providersStartLoginUpgradeV12ToV13,
} from "@traycer/protocol/host/registry";
import {
  providersStartLoginRequestSchemaV12,
  providersStartLoginRequestSchemaV13,
  providersStartLoginResponseSchemaV12,
} from "@traycer/protocol/host/provider-schemas";
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
    const parsedClaude =
      claudeChatSessionAnchorSchema.parse(legacyClaudeAnchor);
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
    // Same old-host guard as the two fields above: a build that predates
    // rateLimitLimitedScopes yields null (profile-level fallback in the GUI).
    expect(state.profiles[0].rateLimitLimitedScopes).toBeNull();
  });

  it("degrades a malformed rateLimitLimitedScopes to null without dropping the profile", () => {
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
          // A newer host's severity vocabulary grew a value this client's
          // frozen enum doesn't know - the whole field must degrade to null
          // (profile-level fallback) instead of wiping the profile via the
          // array-level `.catch([])` on `profiles`.
          rateLimitLimitedScopes: [{ family: "Fable", severity: "soft_limit" }],
        },
      ],
    });
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].rateLimitLimitedScopes).toBeNull();
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

describe("providers.list@8.0 freeze rejects the wave-2 authType widening", () => {
  it('a profile row with authType: "apiKey" fails to parse providerProfileSchemaV80', () => {
    // The freeze made executable in the direction wave 2 will push (W1-T9):
    // `providerProfileAuthTypeSchema` is `z.enum(["oauth"])` and stays that
    // way (critique B1) - `apiKey` is a W2-T1 addition that must ride a new
    // v9.0 enum, never widen this already-shipped row in place.
    //
    // Asserted directly against `providerProfileSchemaV80`, not against the
    // full `providersListResponseSchemaV80` - the array-level `profiles:
    // z.array(...).catch([])` on `providerCliStateSchemaV80` is deliberately
    // forgiving (see its own comment on why: one out-of-palette value must
    // not wipe every profile for a provider), so a full-response parse of
    // this same row would succeed with `profiles: []` rather than fail. The
    // row schema itself has no such catch, so it is where "fails to parse"
    // is actually true.
    const result = providerProfileSchemaV80.safeParse({
      profileId: "profile-1",
      kind: "managed" as const,
      authType: "apiKey",
      label: "Work",
      auth: {
        status: "authenticated" as const,
        badgeText: null,
        label: null,
        detail: null,
      },
      identity: null,
      usageUpdatedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("providers.list latest -> v2.0 downgrade strips profiles[]", () => {
  it("providerCliStateSchemaV20 drops an unmodeled profiles key on parse", () => {
    // Regression guard for the leak this frozen schema used to have: it was
    // defined via `.extend()` on the live (growing) schema, so it silently
    // inherited `profiles` instead of staying pinned to what v2.0 shipped.
    const parsed = providerCliStateSchemaV20.parse(stateWithProfile);
    expect(parsed).not.toHaveProperty("profiles");
  });

  it("downgradeProviderCliStateListToV20 never leaks profile identity to a v2.0 caller", () => {
    // Latest major carries profiles[]; the path from latest → v2.0 must strip
    // them. The major is spelled out because `downgradeResponseAcrossMajors`
    // resolves it at the type level, so it cannot be read off the registry at
    // runtime - it has to be bumped by hand every time a new major opens
    // (v5.0/v6.0/v7.0/v8.0 were each frozen by a release; v9.0 is the newest
    // line and is not released yet). The latest major also carries
    // `nativeCapabilities` and `native`, which this downgrade strips alongside
    // `profiles`.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      2,
      providersListResponseSchema.parse({
        providers: [stateWithProfile],
        native: null,
      }),
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

describe("providers.list v3.0 line predates profiles[]", () => {
  it("providerCliStateSchemaV30 drops an unmodeled profiles key on parse", () => {
    // The v3.0 line shipped without profiles - the frozen shape must stay
    // pinned to what released v3.0 hosts actually send, not inherit the
    // field the live shape grew mid-line.
    const parsed = providerCliStateSchemaV30.parse(stateWithProfile);
    expect(parsed).not.toHaveProperty("profiles");
  });

  it("upgrades a pre-profiles v3.0 response to v4.0 with profiles: []", () => {
    // Released-host crash regression: a v3.0 host (e.g. host 1.1.6) sends
    // providers without any `profiles` key. The 3.0 -> 4.0 upgrade must hand
    // the caller providers matching the live contract - `profiles: []`, never
    // undefined (the GUI reads `provider.profiles.some(...)` unconditionally).
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 3, minor: 0 },
      { major: 4, minor: 0 },
      providersListResponseSchemaV30.parse({
        providers: [providerState("amp")],
      }),
    );
    expect(upgraded.providers[0].profiles).toEqual([]);
  });

  it("upgrades a v2.0 response to v4.0 with profiles: [] along the chain", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 2, minor: 0 },
      { major: 4, minor: 0 },
      providersListResponseSchemaV20.parse({
        providers: [providerState("codex")],
      }),
    );
    expect(upgraded.providers[0].profiles).toEqual([]);
  });

  it("latest -> v3.0 downgrade never leaks profile identity to a v3.0 caller", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      3,
      providersListResponseSchema.parse({
        providers: [stateWithProfile],
        native: null,
      }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty("profiles");
    const serialized = JSON.stringify(downgraded.value);
    expect(serialized).not.toContain("work@example.com");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("profile-0");
  });
});

describe("provider.* mutation major-2 lines predate profiles[]", () => {
  it("providerMutationCliStateSchemaV20 drops an unmodeled profiles key on parse", () => {
    // The released 2.0 mutation responses reused the live state and silently
    // gained `profiles` - the frozen shape must stay pinned to what released
    // 2.0 hosts actually send (and what host-side projection onto 2.0 may
    // put on the wire).
    const parsed = providerMutationCliStateSchemaV20.parse(stateWithProfile);
    expect(parsed).not.toHaveProperty("profiles");
  });

  it("upgrades a released 2.0 setSelection response to 2.1 with profiles: []", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.setSelection"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      {
        state: providerMutationCliStateSchemaV20.parse(
          providerState("claude-code"),
        ),
      },
    );
    expect(upgraded.state.profiles).toEqual([]);
  });

  it("upgrades a 1.0 setEnabled response to the 2.1 canonical along the chain", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.setEnabled"],
      { major: 1, minor: 0 },
      { major: 2, minor: 1 },
      {
        state: providerCliStateSchemaV10.parse(providerState("codex")),
      },
    );
    expect(upgraded.state.profiles).toEqual([]);
    expect(upgraded.state.availabilityPending).toBe(false);
  });

  it("upgrades a released 2.0 awaitLogin response to 2.1 with profiles and existingProfileId defaults", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.awaitLogin"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      {
        state: providerMutationCliStateSchemaV20.parse(
          providerState("claude-code"),
        ),
      },
    );
    expect(upgraded.state?.profiles).toEqual([]);
    expect(upgraded.existingProfileId).toBeNull();

    const upgradedNull = upgradeResponseToVersion(
      hostRpcRegistry["providers.awaitLogin"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      { state: null },
    );
    expect(upgradedNull.state).toBeNull();
    expect(upgradedNull.existingProfileId).toBeNull();
  });

  it("upgrades a released 2.0 awaitLogin request to 2.1 with profileId: null and mcpAuth: null", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["providers.awaitLogin"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      { providerId: "claude-code" },
    );
    expect(upgraded).toEqual({
      providerId: "claude-code",
      profileId: null,
    });
  });

  it("2.1 -> 1.0 downgrade still strips profiles and profile identity", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.setSelection"],
      2,
      1,
      // Re-parsed through the mutation line's own `@2.1` state: a
      // `providers.setSelection` response has never carried
      // `providers.list@9.0`'s `authType:"apiKey"` / `endpoint` / `config`.
      { state: providerMutationCliStateSchemaV21.parse(stateWithProfile) },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.state).not.toHaveProperty("profiles");
    expect(JSON.stringify(downgraded.value)).not.toContain("work@example.com");
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

describe("providers.startLogin@1.2 (D21/D22 mode/userCode)", () => {
  it("upgrades a v1.1 request to v1.2 with mode defaulted to browser", () => {
    const upgraded = providersStartLoginUpgradeV11ToV12.upgradeRequest({
      providerId: "codex",
      profileId: null,
      createProfile: null,
    });
    expect(upgraded).toEqual({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      mode: "browser",
    });
  });

  it("upgrades a v1.1 response to v1.2 with userCode defaulted to null", () => {
    const upgraded = providersStartLoginUpgradeV11ToV12.upgradeResponse({
      url: "https://example.com/oauth",
      started: true,
      profileId: null,
    });
    expect(upgraded).toEqual({
      url: "https://example.com/oauth",
      started: true,
      profileId: null,
      userCode: null,
    });
  });

  it("upgrades through the real registry with the same fill", () => {
    const upgradedRequest = upgradeRequestToVersion(
      hostRpcRegistry["providers.startLogin"],
      { major: 1, minor: 1 },
      { major: 1, minor: 2 },
      { providerId: "codex", profileId: null, createProfile: null },
    );
    expect(upgradedRequest).toMatchObject({ mode: "browser" });

    const upgradedResponse = upgradeResponseToVersion(
      hostRpcRegistry["providers.startLogin"],
      { major: 1, minor: 1 },
      { major: 1, minor: 2 },
      { url: null, started: true, profileId: null },
    );
    expect(upgradedResponse).toMatchObject({ userCode: null });
  });

  it("a v1.2 response round-trips a device-flow userCode", () => {
    const parsed = providersStartLoginResponseSchemaV12.parse({
      url: null,
      started: true,
      profileId: null,
      userCode: "ABCD-1234",
    });
    expect(parsed.userCode).toBe("ABCD-1234");
  });

  it("a v1.2 request accepts an explicit device mode", () => {
    const parsed = providersStartLoginRequestSchemaV12.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      mode: "device",
    });
    expect(parsed.mode).toBe("device");
  });
});

// ── providers.startLogin@1.3 (D32/W2-T10b `startFrom`) ────────────────────
//
// `providers.startLogin` is on the released floor, so the ONLY growth it may
// take is an additive minor whose fill is what the old peer already meant. A
// released v1.1/v1.2 client's "Add profile -> sign in" seeded nothing, so the
// fill and the schema default are both `{ kind: "empty" }`. D25's "Default
// account" is the Add-profile DIALOG's default and the GUI sends it
// explicitly; it is not the meaning of an absent field.
describe("providers.startLogin@1.3 (D32 startFrom)", () => {
  const V12_REQUEST = {
    providerId: "codex" as const,
    profileId: null,
    createProfile: null,
    mode: "browser" as const,
  };

  it("upgrades a v1.2 request to v1.3 with startFrom: empty", () => {
    expect(
      providersStartLoginUpgradeV12ToV13.upgradeRequest(V12_REQUEST),
    ).toEqual({ ...V12_REQUEST, startFrom: { kind: "empty" } });
  });

  it("upgrades through the real registry with the same fill", () => {
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["providers.startLogin"],
        { major: 1, minor: 2 },
        { major: 1, minor: 3 },
        V12_REQUEST,
      ),
    ).toMatchObject({ startFrom: { kind: "empty" } });
  });

  it("a v1.3 request with no startFrom parses to the same value the upgrade fills", () => {
    const parsed = providersStartLoginRequestSchemaV13.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      mode: "browser",
    });
    expect(parsed.startFrom).toEqual({ kind: "empty" });
  });

  it("round-trips an explicit profile seed source", () => {
    const parsed = providersStartLoginRequestSchemaV13.parse({
      ...V12_REQUEST,
      startFrom: { kind: "profile", profileId: "p1" },
    });
    expect(parsed.startFrom).toEqual({ kind: "profile", profileId: "p1" });
    expect(
      providersStartLoginRequestSchemaV13.safeParse({
        ...V12_REQUEST,
        startFrom: { kind: "profile", profileId: "" },
      }).success,
    ).toBe(false);
  });

  it("1.3 is the latest installed minor of major 1", () => {
    expect(hostRpcRegistry["providers.startLogin"][1].latestMinor).toBe(3);
  });
});

describe("providers.awaitLogin v2->v1 downgrade strips profileId", () => {
  it("drops profileId before the strict v1.0 request parse", () => {
    const downgraded = providersAwaitLoginDowngradeV21ToV10.downgradeRequest({
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
  it("upgrades a v2.0 request to v2.1 with profileAction/native defaulted to null", () => {
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
      {
        providerId: "codex",
        enabled: false,
        profileAction: null,
      },
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

// ── providers.list@9.0 (W2-T2, D21) ─────────────────────────────────────────

function oauthProfileRow(profileId: string) {
  return {
    profileId,
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
  };
}

function apiKeyProfileRow(profileId: string) {
  return {
    profileId,
    kind: "managed" as const,
    authType: "apiKey" as const,
    label: "API key",
    auth: {
      status: "authenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    endpoint: {
      host: "https://api.example.com",
      model: null,
      credentialKind: "api_key" as const,
      credentialConfigured: true,
      lastTest: null,
    },
    config: {
      skills: "linked" as const,
      plugins: "linked" as const,
      cliSelection: { kind: "bundled" as const, pinned: false },
    },
  };
}

describe("providers.list@9.0 downgrade bridges strip apiKey rows (D21/M12)", () => {
  it.each([8, 7, 6, 5, 4] as const)(
    "downgrades to v%i.0 with the oauth row surviving, the apiKey row gone, and the provider itself not dropped",
    (target) => {
      const response = providersListResponseSchema.parse({
        providers: [
          {
            ...providerState("claude-code"),
            profiles: [
              apiKeyProfileRow("profile-key"),
              oauthProfileRow("profile-oauth"),
            ],
          },
        ],
        native: null,
      });
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        9,
        target,
        response,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.providers).toHaveLength(1);
      const profileIds = downgraded.value.providers[0].profiles.map(
        (profile: { profileId: string }) => profile.profileId,
      );
      expect(profileIds).toContain("profile-oauth");
      expect(profileIds).not.toContain("profile-key");
    },
  );

  // v1.0..v3.0 never modelled `profiles[]` at all (it arrived at v4.0), so
  // there is no per-row assertion to make below v4.0 - only that the
  // provider row itself survives the downgrade rather than being dropped.
  it.each([3, 2, 1] as const)(
    "downgrades to v%i.0 with the provider row surviving (profiles[] isn't modelled below v4.0)",
    (target) => {
      const response = providersListResponseSchema.parse({
        providers: [
          {
            ...providerState("claude-code"),
            profiles: [
              apiKeyProfileRow("profile-key"),
              oauthProfileRow("profile-oauth"),
            ],
          },
        ],
        native: null,
      });
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        9,
        target,
        response,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.providers).toHaveLength(1);
      expect(downgraded.value.providers[0]).not.toHaveProperty("profiles");
    },
  );

  it("the apiKey row first in the array does not wipe the rest (critique M12)", () => {
    const response = providersListResponseSchema.parse({
      providers: [
        {
          ...providerState("claude-code"),
          profiles: [
            apiKeyProfileRow("profile-key"),
            oauthProfileRow("profile-oauth"),
          ],
        },
      ],
      native: null,
    });
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      8,
      response,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0].profiles).toHaveLength(1);
    expect(downgraded.value.providers[0].profiles[0].profileId).toBe(
      "profile-oauth",
    );
  });

  it("providerProfileSchemaV80.parse of a row carrying unknown endpoint/config keys keeps the profiles array non-empty", () => {
    const raw = {
      ...oauthProfileRow("profile-oauth"),
      endpoint: { host: "https://api.example.com" },
      config: { skills: "own" },
    };
    const parsed = providerProfileSchemaV80.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("endpoint");
    expect(parsed.data).not.toHaveProperty("config");
  });

  it("providerProfileSchema.parse degrades a garbage endpoint to null and keeps every other field", () => {
    const parsed = providerProfileSchema.parse({
      ...oauthProfileRow("profile-oauth"),
      endpoint: "garbage",
    });
    expect(parsed.endpoint).toBeNull();
    expect(parsed.profileId).toBe("profile-oauth");
    expect(parsed.label).toBe("Work");
  });

  it("providers.list@8.0 freeze is behaviour-preserving for the v9.0 additions: the fully-populated row round trip still holds", () => {
    const canonical = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      profiles: [oauthProfileRow("profile-oauth")],
      // W2-T10b: the row's endpoint-capabilities summary - present on the
      // live/v9.0 shape, absent from the v8.0/v7.0 frozen bases (neither
      // extends the live `providerCliStateBaseShape`).
      endpointCapabilities: {
        supportsBaseUrl: true,
        credentialKinds: ["api_key", "auth_token"],
        requiresModel: false,
        extraFields: [],
        credentialStoredInNativeConfig: false,
      },
    });
    const viaLive = providersListResponseSchema.parse({
      providers: [canonical],
      native: null,
    });
    const viaV80 = providersListResponseSchemaV80.parse({
      providers: [canonical],
      native: null,
    });
    // v8.0 never modelled `endpoint`/`config`/`profilesSupported`/
    // `endpointCapabilities` - they drop on reparse, exactly like `enabled`
    // never modelled anything past v7.0.
    expect(viaV80.providers[0].profiles[0]).not.toHaveProperty("endpoint");
    expect(viaV80.providers[0].profiles[0]).not.toHaveProperty("config");
    expect(viaV80.providers[0]).not.toHaveProperty("profilesSupported");
    expect(viaV80.providers[0]).not.toHaveProperty("endpointCapabilities");
    expect(viaLive.providers[0].endpointCapabilities).not.toBeNull();
    expect(viaV80.providers[0].profiles[0].profileId).toBe(
      viaLive.providers[0].profiles[0].profileId,
    );
    expect(viaV80.providers[0].profiles[0].label).toBe(
      viaLive.providers[0].profiles[0].label,
    );
  });

  it("request downgrade drops profileId from the native arm at v8.0 and v7.0, and drops native entirely at v6.0 and below", () => {
    const request = providersListRequestSchema.parse({
      forceAuthRefresh: true,
      native: {
        kind: "skills",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
        profileId: "profile-1",
      },
    });
    const toV8 = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      8,
      request,
    );
    expect(toV8.ok).toBe(true);
    if (toV8.ok) {
      expect(toV8.value.native).not.toHaveProperty("profileId");
    }

    // v7.0 is the target with its OWN reparse
    // (`providersListRequestSchemaV70`); 6 and below share
    // `providersListRequestSchemaBeforeV70`, so 8 and 6 alone leave the
    // middle bridge unproved.
    const toV7 = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      7,
      request,
    );
    expect(toV7.ok).toBe(true);
    if (toV7.ok) {
      expect(toV7.value.native).not.toBeNull();
      expect(toV7.value.native).not.toHaveProperty("profileId");
    }

    const toV6 = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      6,
      request,
    );
    expect(toV6.ok).toBe(true);
    if (toV6.ok) {
      expect(toV6.value).not.toHaveProperty("native");
    }
  });

  it("upgrade v8.0 -> v9.0 fills profilesSupported: false and endpoint/config: null on every profile", () => {
    const v80Response = providersListResponseSchemaV80.parse({
      providers: [
        {
          ...providerState("claude-code"),
          profiles: [oauthProfileRow("profile-oauth")],
        },
      ],
      native: null,
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      v80Response,
    );
    expect(upgraded.providers[0].profilesSupported).toBe(false);
    expect(upgraded.providers[0].profiles[0].endpoint).toBeNull();
    expect(upgraded.providers[0].profiles[0].config).toBeNull();
    expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
  });
});

// ── agent.listProviderProfiles@5.1 (W2-T3, critique H8) ────────────────────

function agentProfileSummaryRow(authType: "oauth" | "apiKey") {
  return {
    selection: { kind: "ambient" as const },
    label: "Row",
    authStatus: "authenticated" as const,
    rateLimitStatus: "unknown" as const,
    usageUpdatedAt: null,
    isEffectiveLastUsed: false,
    authType,
  };
}

describe("agent.listProviderProfiles@5.1 authType (D06/D27, critique H8)", () => {
  it("5.0 -> 5.1 upgrade fills authType: oauth on every row", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["agent.listProviderProfiles"],
      { major: 5, minor: 0 },
      { major: 5, minor: 1 },
      {
        providerId: "claude-code",
        profiles: [
          {
            selection: { kind: "ambient" },
            label: "Row",
            authStatus: "authenticated",
            rateLimitStatus: "unknown",
            usageUpdatedAt: null,
            isEffectiveLastUsed: false,
          },
        ],
      },
    );
    expect(upgraded.profiles[0].authType).toBe("oauth");
  });

  it.each([4, 3, 2, 1] as const)(
    "an apiKey row downgraded to v%i.0 keeps the row and drops authType",
    (target) => {
      const response = {
        providerId: "claude-code" as const,
        profiles: [agentProfileSummaryRow("apiKey")],
      };
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["agent.listProviderProfiles"],
        5,
        target,
        response,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.profiles).toHaveLength(1);
      expect(downgraded.value.profiles[0]).not.toHaveProperty("authType");
    },
  );
});

// ── The v8.0-SOURCE bridges (W1-T9 freeze fallout) ────────────────────────
//
// W1-T9 froze `providersListResponseSchemaV80`, which turned every
// `providersListDowngradeV8ToV*` bridge into one whose SOURCE rows are
// V80-shaped rather than live. Nothing exercised them from a v8.0-shaped
// response afterwards, so the two things that broke - the live-typed
// `enabledProviderProfilesOnly` filter and `downgradeProviderCliStateToV10`'s
// `DowngradableToV10ProviderState` union, which had no V80 arm - failed at
// type-check only and no test could see it. Driven through the real registry
// so it is major 8's own `downgradePathsFromLatest` table being used, not the
// bridge objects directly.
describe("providers.list@8.0 -> every older major via the real registry", () => {
  const FROZEN_BY_MAJOR = {
    7: providersListResponseSchemaV70,
    6: providersListResponseSchemaV60,
    5: providersListResponseSchemaV50,
    4: providersListResponseSchemaV40,
    3: providersListResponseSchemaV30,
    2: providersListResponseSchemaV20,
    1: providersListResponseSchemaV10,
  } as const;

  function v80ResponseWithMixedProfiles() {
    return providersListResponseSchemaV80.parse({
      providers: [
        {
          ...providerState("claude-code"),
          profiles: [
            { ...oauthProfileRow("profile-on"), enabled: true },
            { ...oauthProfileRow("profile-off"), enabled: false },
          ],
        },
      ],
      native: null,
    });
  }

  it.each([7, 6, 5, 4, 3, 2, 1] as const)(
    "downgrades a v8.0 response to v%i.0 and drops the disabled profile",
    (targetMajor) => {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
        targetMajor,
        v80ResponseWithMixedProfiles(),
      );
      expect(downgraded.ok, `v${targetMajor}.0`).toBe(true);
      if (!downgraded.ok) return;
      expect(
        FROZEN_BY_MAJOR[targetMajor].safeParse(downgraded.value).success,
        `v${targetMajor}.0 parses`,
      ).toBe(true);
      // `profile-off` must not survive at any target: majors 6 and below run
      // it through `enabledProviderProfilesOnly`, major 7 through
      // `downgradeProviderCliStateListToV70`'s own enabled filter, and majors
      // 3 and below model no `profiles` at all.
      expect(JSON.stringify(downgraded.value)).not.toContain("profile-off");
    },
  );

  it("keeps the enabled profile for the two majors that still model profiles", () => {
    for (const targetMajor of [7, 6] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
        targetMajor,
        v80ResponseWithMixedProfiles(),
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      expect(
        downgraded.value.providers[0]?.profiles.map(
          (profile) => profile.profileId,
        ),
        `v${targetMajor}.0`,
      ).toEqual(["profile-on"]);
    }
  });
});
