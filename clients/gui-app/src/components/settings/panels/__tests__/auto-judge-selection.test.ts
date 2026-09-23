import { describe, expect, it } from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  autoJudgeRecordHealth,
  defaultJudgeModelFor,
  firstOfferedJudgeProfileId,
  judgeModelUnavailable,
  judgeProfileBlocker,
  judgeProfileUnavailable,
  judgeProviderBlocker,
  judgeSelectionForProvider,
  offeredJudgeProfileIds,
  providerForHarness,
} from "@/components/settings/panels/auto-judge-selection";

function harness(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
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

function model(slug: string): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId: "claude",
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: {},
  });
}

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: profileId,
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
    ambientDriftNotice: null,
    accentColor: null,
    ...overrides,
  };
}

function provider(
  providerId: ProviderId,
  profiles: ProviderProfile[],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

describe("judgeProviderBlocker", () => {
  it("says Turned off first, whatever else is wrong", () => {
    expect(
      judgeProviderBlocker(
        harness({
          enabled: false,
          authStatus: "unauthenticated",
          available: false,
        }),
      ),
    ).toBe("Turned off");
  });

  it("says Signed out for an unauthenticated verdict or a missing credential", () => {
    expect(
      judgeProviderBlocker(harness({ authStatus: "unauthenticated" })),
    ).toBe("Signed out");
    expect(
      judgeProviderBlocker(
        harness({ available: false, unavailableReason: "missing-credential" }),
      ),
    ).toBe("Signed out");
  });

  it("says Not installed for an unavailable, settled row", () => {
    expect(
      judgeProviderBlocker(
        harness({ available: false, unavailableReason: "missing-binary" }),
      ),
    ).toBe("Not installed");
  });

  it("says Not available when the reason is `other`", () => {
    expect(
      judgeProviderBlocker(
        harness({ available: false, unavailableReason: "other" }),
      ),
    ).toBe("Not available");
  });

  it("claims nothing while the availability probe is still pending", () => {
    expect(
      judgeProviderBlocker(
        harness({ available: false, availabilityPending: true }),
      ),
    ).toBeNull();
  });

  it("is null for a healthy row", () => {
    expect(judgeProviderBlocker(harness({}))).toBeNull();
  });
});

describe("judgeProfileBlocker", () => {
  it("says Turned off for a host-wide disabled account", () => {
    expect(
      judgeProfileBlocker(profile("p", "managed", { enabled: false })),
    ).toBe("Turned off");
  });

  it("says No API key when the provider takes a key and none is stored", () => {
    expect(
      judgeProfileBlocker(
        profile("p", "managed", {
          apiKey: { supported: true, configured: false },
        }),
      ),
    ).toBe("No API key");
  });

  it("is null for a configured key, an unsupported key method, or no key state", () => {
    expect(
      judgeProfileBlocker(
        profile("p", "managed", {
          apiKey: { supported: true, configured: true },
        }),
      ),
    ).toBeNull();
    expect(
      judgeProfileBlocker(
        profile("p", "managed", {
          apiKey: { supported: false, configured: false },
        }),
      ),
    ).toBeNull();
    expect(judgeProfileBlocker(profile("p", "managed", {}))).toBeNull();
  });
});

describe("providerForHarness", () => {
  const claude = provider("claude-code", []);
  const codex = provider("codex", []);

  it("projects provider -> harness id", () => {
    expect(providerForHarness([codex, claude], "claude")).toBe(claude);
  });

  it("is undefined for an unknown harness or an unanswered read", () => {
    expect(providerForHarness([codex], "claude")).toBeUndefined();
    expect(providerForHarness(undefined, "claude")).toBeUndefined();
  });
});

describe("firstOfferedJudgeProfileId", () => {
  it("returns the first runnable account as a commit id, skipping blocked ones", () => {
    const state = provider("claude-code", [
      profile("off", "managed", { enabled: false }),
      profile("work", "managed", {}),
    ]);
    expect(firstOfferedJudgeProfileId(state)).toBe("work");
  });

  it("returns null (ambient) when the first runnable account is the ambient one", () => {
    expect(
      firstOfferedJudgeProfileId(
        provider("claude-code", [profile("ambient", "ambient", {})]),
      ),
    ).toBeNull();
  });

  it("returns null when nothing is runnable or the provider is unknown", () => {
    expect(
      firstOfferedJudgeProfileId(
        provider("claude-code", [
          profile("off", "managed", { enabled: false }),
        ]),
      ),
    ).toBeNull();
    expect(firstOfferedJudgeProfileId(undefined)).toBeNull();
  });
});

describe("defaultJudgeModelFor", () => {
  it("prefers the row's judgeDefaultModel", () => {
    expect(
      defaultJudgeModelFor(harness({ judgeDefaultModel: "haiku" }), [
        model("opus"),
      ]),
    ).toBe("haiku");
  });

  it("falls back to the catalog's first model when the row names none or an empty one", () => {
    expect(
      defaultJudgeModelFor(harness({}), [model("opus"), model("haiku")]),
    ).toBe("opus");
    expect(
      defaultJudgeModelFor(harness({ judgeDefaultModel: "" }), [model("opus")]),
    ).toBe("opus");
  });

  it("is null when neither is known", () => {
    expect(defaultJudgeModelFor(harness({}), undefined)).toBeNull();
    expect(defaultJudgeModelFor(harness({}), [])).toBeNull();
  });
});

describe("judgeSelectionForProvider", () => {
  it("commits the provider, its default model and its first runnable account", () => {
    expect(
      judgeSelectionForProvider({
        row: harness({ judgeDefaultModel: "haiku" }),
        models: [model("opus")],
        provider: provider("claude-code", [profile("work", "managed", {})]),
      }),
    ).toEqual({ harnessId: "claude", model: "haiku", profileId: "work" });
  });

  it("is null while the model is not known", () => {
    expect(
      judgeSelectionForProvider({
        row: harness({}),
        models: undefined,
        provider: undefined,
      }),
    ).toBeNull();
  });
});

describe("judgeModelUnavailable", () => {
  it("is true when the stored slug has left the catalog", () => {
    expect(judgeModelUnavailable("gone", [model("opus")])).toBe(true);
  });

  it("is false for a listed slug, an empty slug, or an unanswered catalog", () => {
    expect(judgeModelUnavailable("opus", [model("opus")])).toBe(false);
    expect(judgeModelUnavailable("", [model("opus")])).toBe(false);
    expect(judgeModelUnavailable("gone", undefined)).toBe(false);
  });
});

describe("judgeProfileUnavailable", () => {
  it("is true when the stored account is no longer offered", () => {
    expect(judgeProfileUnavailable("gone", [null, "work"])).toBe(true);
  });

  it("is false for ambient, an offered account, or an unanswered read", () => {
    expect(judgeProfileUnavailable(null, [])).toBe(false);
    expect(judgeProfileUnavailable("work", [null, "work"])).toBe(false);
    expect(judgeProfileUnavailable("work", undefined)).toBe(false);
  });
});

describe("offeredJudgeProfileIds", () => {
  it("projects the provider's profiles to commit ids", () => {
    const state = provider("claude-code", [
      profile("ambient", "ambient", {}),
      profile("work", "managed", {}),
    ]);
    expect(offeredJudgeProfileIds([state], "claude")).toEqual([null, "work"]);
  });

  it("is undefined when providers have not answered or the harness maps to none", () => {
    expect(offeredJudgeProfileIds(undefined, "claude")).toBeUndefined();
    expect(offeredJudgeProfileIds([], "claude")).toBeUndefined();
  });
});

describe("autoJudgeRecordHealth", () => {
  const healthy = {
    hasStoredSelection: true,
    unrecognizedHarnessId: null,
    isBlocked: false,
    saving: false,
    storedHarness: harness({}),
    storedModelSlug: "opus",
    offeredModels: [model("opus")],
    storedProfileId: "work",
    offeredProfileIds: [null, "work"],
  };

  it("reports nothing wrong for a healthy record", () => {
    expect(autoJudgeRecordHealth(healthy)).toEqual({
      storedHarnessUnavailable: false,
      storedModelUnavailable: false,
      storedProfileUnavailable: false,
      noJudgeWillRun: false,
    });
  });

  it("flags a stored provider that cannot run, and suppresses the model and account findings under it", () => {
    const health = autoJudgeRecordHealth({
      ...healthy,
      storedHarness: harness({ enabled: false }),
      storedModelSlug: "gone",
      storedProfileId: "gone",
    });
    expect(health).toEqual({
      storedHarnessUnavailable: true,
      storedModelUnavailable: false,
      storedProfileUnavailable: false,
      noJudgeWillRun: true,
    });
  });

  it("flags a stored model that left the catalog", () => {
    const health = autoJudgeRecordHealth({
      ...healthy,
      storedModelSlug: "gone",
    });
    expect(health.storedModelUnavailable).toBe(true);
    expect(health.noJudgeWillRun).toBe(true);
  });

  it("flags a stored account that left the provider", () => {
    const health = autoJudgeRecordHealth({
      ...healthy,
      storedProfileId: "gone",
    });
    expect(health.storedProfileUnavailable).toBe(true);
    expect(health.noJudgeWillRun).toBe(true);
  });

  it("diagnoses nothing while a write is in flight", () => {
    const health = autoJudgeRecordHealth({
      ...healthy,
      saving: true,
      storedModelSlug: "gone",
      storedProfileId: "gone",
    });
    expect(health.storedModelUnavailable).toBe(false);
    expect(health.storedProfileUnavailable).toBe(false);
  });

  it("diagnoses nothing for a record this build cannot read, or with no stored selection", () => {
    expect(
      autoJudgeRecordHealth({
        ...healthy,
        unrecognizedHarnessId: "future",
        storedModelSlug: "gone",
      }).storedModelUnavailable,
    ).toBe(false);
    expect(
      autoJudgeRecordHealth({
        ...healthy,
        hasStoredSelection: false,
        storedModelSlug: "gone",
      }).storedModelUnavailable,
    ).toBe(false);
  });

  it("treats a catalog or providers read that has not answered as unknown, not gone", () => {
    const health = autoJudgeRecordHealth({
      ...healthy,
      storedHarness: undefined,
      offeredModels: undefined,
      offeredProfileIds: undefined,
      storedModelSlug: "gone",
      storedProfileId: "gone",
    });
    expect(health.noJudgeWillRun).toBe(false);
  });

  it("noJudgeWillRun follows isBlocked on its own", () => {
    expect(
      autoJudgeRecordHealth({ ...healthy, isBlocked: true }).noJudgeWillRun,
    ).toBe(true);
  });
});
