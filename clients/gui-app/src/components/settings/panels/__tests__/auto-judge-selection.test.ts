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
  defaultJudgeModelFor,
  firstOfferedJudgeProfileId,
  judgeModelUnavailable,
  judgeModelsFailedLine,
  judgeNoModelsLine,
  judgeProfileBlocker,
  judgeProfileUnavailable,
  judgeProviderBlocker,
  judgeSelectionForProvider,
  judgeWarningCause,
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

describe("judgeWarningCause", () => {
  const healthy = {
    stored: { harnessId: "claude", model: "opus", profileId: "work" },
    blocked: null,
    harnesses: [harness({})],
    offeredModels: [model("opus")],
    offeredProfileIds: [null, "work"],
  };
  const allGone = {
    ...healthy,
    stored: { harnessId: "claude", model: "gone", profileId: "gone" },
  };

  it("is null for a healthy record", () => {
    expect(judgeWarningCause(healthy)).toBeNull();
  });

  it("puts the host's blocked verdict first, whatever else is wrong", () => {
    for (const reason of [
      "provider-disabled",
      "unsupported-harness",
    ] as const) {
      expect(
        judgeWarningCause({
          ...allGone,
          blocked: { reason },
          harnesses: [harness({ enabled: false })],
        }),
      ).toEqual({ kind: reason });
    }
  });

  it("says nothing past the host's verdict while the harness catalog has not answered", () => {
    expect(judgeWarningCause({ ...allGone, harnesses: undefined })).toBeNull();
  });

  it("reports a stored harness with no catalog row as unrecognized", () => {
    expect(
      judgeWarningCause({ ...healthy, harnesses: [harness({ id: "codex" })] }),
    ).toEqual({ kind: "unrecognized" });
  });

  it("reports each provider blocker ahead of a gone model or account", () => {
    const rows: ReadonlyArray<[Partial<GuiHarnessOption>, string]> = [
      [{ enabled: false }, "Turned off"],
      [{ authStatus: "unauthenticated" }, "Signed out"],
      [
        { available: false, unavailableReason: "missing-binary" },
        "Not installed",
      ],
      [{ available: false, unavailableReason: "other" }, "Not available"],
    ];
    for (const [overrides, blocker] of rows) {
      expect(
        judgeWarningCause({ ...allGone, harnesses: [harness(overrides)] }),
      ).toEqual({ kind: "provider", blocker });
    }
  });

  it("reports a gone model ahead of a gone account", () => {
    expect(judgeWarningCause(allGone)).toEqual({ kind: "model" });
  });

  it("reports a gone account when the model is fine", () => {
    expect(
      judgeWarningCause({
        ...healthy,
        stored: { harnessId: "claude", model: "opus", profileId: "gone" },
      }),
    ).toEqual({ kind: "profile" });
  });

  it("counts a resolvedModel alias as offered", () => {
    const aliased = guiAgentModelOptionSchema.parse({
      harnessId: "claude",
      slug: "opus[1m]",
      label: "Opus",
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      metadata: { resolvedModel: "claude-opus-5" },
    });
    expect(
      judgeWarningCause({
        ...healthy,
        stored: {
          harnessId: "claude",
          model: "claude-opus-5",
          profileId: null,
        },
        offeredModels: [aliased],
      }),
    ).toBeNull();
  });

  it("treats a model catalog or providers read that has not answered as no finding", () => {
    expect(
      judgeWarningCause({
        ...allGone,
        offeredModels: undefined,
        offeredProfileIds: undefined,
      }),
    ).toBeNull();
  });

  it("never reports the ambient account as gone", () => {
    expect(
      judgeWarningCause({
        ...healthy,
        stored: { harnessId: "claude", model: "opus", profileId: null },
        offeredProfileIds: [],
      }),
    ).toBeNull();
  });
});

describe("the pick lines", () => {
  it("names the provider in the no-models line", () => {
    expect(judgeNoModelsLine("Codex")).toBe(
      "Codex offers no models on this machine. Pick another provider.",
    );
  });

  it("names the provider in the models-failed line", () => {
    expect(judgeModelsFailedLine("Codex")).toBe(
      "Couldn't load Codex's models. Reopen Settings to try again, or pick another provider.",
    );
  });
});
