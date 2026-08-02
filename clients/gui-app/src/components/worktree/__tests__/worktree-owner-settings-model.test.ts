import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { describe, expect, it } from "vitest";
import {
  deriveOwnerSettingsHeader,
  type OwnerSettingsHeaderInput,
} from "@/components/worktree/worktree-owner-settings-model";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";

const BASE_CHAT_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function claudeHarnessEntry(): GuiHarnessCatalogEntry {
  return {
    id: "claude",
    label: "Claude Code",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
    availabilityPending: false,
    models: [
      {
        harnessId: "claude",
        slug: "sonnet-4.5",
        label: "Claude Sonnet 4.5",
        description: null,
        contextWindow: null,
        maxOutputTokens: null,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { id: "high", label: "High", description: null },
          { id: "medium", label: "Medium", description: null },
        ],
        defaultServiceTier: null,
        supportedServiceTiers: [],
        metadata: {},
      },
    ],
    modelsLoading: false,
    modelsError: null,
  };
}

function providerProfile(
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
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function baseInput(
  overrides: Partial<OwnerSettingsHeaderInput>,
): OwnerSettingsHeaderInput {
  return {
    ownerKind: "chat",
    chatSettings: BASE_CHAT_SETTINGS,
    tuiHarnessId: null,
    tuiModel: null,
    tuiReasoningEffort: null,
    tuiProfileId: null,
    harnesses: [claudeHarnessEntry()],
    profiles: [],
    ...overrides,
  };
}

describe("deriveOwnerSettingsHeader", () => {
  it("resolves all six fields for a GUI chat against the live catalog", () => {
    const profileId = "profile-1";
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: {
          ...BASE_CHAT_SETTINGS,
          serviceTier: "fast",
          profileId,
        },
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile(profileId, "managed", "Work account"),
        ],
      }),
    );

    expect(view).toEqual({
      harnessId: "claude",
      harnessName: "Claude Code",
      modelLabel: "Claude Sonnet 4.5",
      reasoningLabel: "High",
      fastMode: true,
      profileAccentDot: {
        profileId,
        accentColor: null,
        label: "Work account",
      },
      permissionMode: "supervised",
    });
  });

  it("resolves a read-only model label through resolvedModel alias drift", () => {
    const entry = claudeHarnessEntry();
    const decoratedModel = entry.models[0];

    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: {
          ...BASE_CHAT_SETTINGS,
          model: "claude-fable-5",
        },
        harnesses: [
          {
            ...entry,
            models: [
              {
                ...decoratedModel,
                slug: "claude-fable-5[1m]",
                label: "Fable 5 (1M)",
                metadata: { resolvedModel: "claude-fable-5" },
              },
            ],
          },
        ],
      }),
    );

    expect(view?.modelLabel).toBe("Fable 5 (1M)");
  });

  it.each([
    { permissionMode: "supervised" as const },
    { permissionMode: "auto_accept_edits" as const },
    { permissionMode: "full_access" as const },
  ])("passes permissionMode %j through verbatim", ({ permissionMode }) => {
    // The mode, not a label: the header resolves BOTH its label and its icon
    // from `findPermissionOption`, which is what stops "Full access" from
    // rendering behind a closed padlock again.
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: { ...BASE_CHAT_SETTINGS, permissionMode },
      }),
    );

    expect(view?.permissionMode).toBe(permissionMode);
  });

  it("badges the ambient profile when the provider has two or more", () => {
    // `profileId: null` is AMBIENT, not "no profile" - it resolves against the
    // ambient row's `profileCommitId()` of null and earns its own mark.
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: { ...BASE_CHAT_SETTINGS, profileId: null },
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile("profile-1", "managed", "Work account"),
        ],
      }),
    );

    expect(view?.profileAccentDot?.label).toBe("Terminal account");
  });

  it("omits the accent dot when the provider has a single profile", () => {
    // Progressive disclosure: a dot that is always there distinguishes nothing.
    const profileId = "profile-1";
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: { ...BASE_CHAT_SETTINGS, profileId },
        profiles: [providerProfile(profileId, "managed", "Work account")],
      }),
    );

    expect(view?.profileAccentDot).toBeNull();
  });

  it("falls back to raw slugs when the catalog is empty", () => {
    const view = deriveOwnerSettingsHeader(baseInput({ harnesses: [] }));

    expect(view).not.toBeNull();
    expect(view?.harnessName).toBe(BASE_CHAT_SETTINGS.harnessId);
    expect(view?.modelLabel).toBe(BASE_CHAT_SETTINGS.model);
    expect(view?.reasoningLabel).toBe(BASE_CHAT_SETTINGS.reasoningEffort);
  });

  it("omits the accent dot when the profile id isn't in the profiles list", () => {
    // Unresolved (cold provider cache / removed profile): omitted rather than
    // guessing a color from an opaque host-generated id.
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: { ...BASE_CHAT_SETTINGS, profileId: "unknown-profile" },
        profiles: [
          providerProfile("other-profile", "managed", "Other"),
          providerProfile("third-profile", "managed", "Third"),
        ],
      }),
    );

    expect(view?.profileAccentDot).toBeNull();
  });

  it("omits the accent dot when the provider cache is cold", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        chatSettings: { ...BASE_CHAT_SETTINGS, profileId: null },
        profiles: [],
      }),
    );

    expect(view?.profileAccentDot).toBeNull();
  });

  it.each([{ serviceTier: null }, { serviceTier: "" }])(
    "treats serviceTier %j as fast mode off",
    ({ serviceTier }) => {
      const view = deriveOwnerSettingsHeader(
        baseInput({
          chatSettings: { ...BASE_CHAT_SETTINGS, serviceTier },
        }),
      );

      expect(view?.fastMode).toBe(false);
    },
  );

  it.each([{ reasoningEffort: null }, { reasoningEffort: "" }])(
    "omits the reasoning row when reasoningEffort is %j",
    ({ reasoningEffort }) => {
      const view = deriveOwnerSettingsHeader(
        baseInput({
          chatSettings: { ...BASE_CHAT_SETTINGS, reasoningEffort },
        }),
      );

      expect(view?.reasoningLabel).toBeNull();
    },
  );

  it("resolves harness + model for a TUI agent, nulling chat-only fields", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
      }),
    );

    expect(view).toEqual({
      harnessId: "claude",
      harnessName: "Claude Code",
      modelLabel: "Claude Sonnet 4.5",
      reasoningLabel: null,
      fastMode: false,
      profileAccentDot: null,
      permissionMode: null,
    });
  });

  it("resolves managed-profile TUI identity: badge, model, and effort", () => {
    const profileId = "profile-1";
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
        tuiReasoningEffort: "high",
        tuiProfileId: profileId,
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile(profileId, "managed", "Work account"),
        ],
      }),
    );

    expect(view).toEqual({
      harnessId: "claude",
      harnessName: "Claude Code",
      modelLabel: "Claude Sonnet 4.5",
      reasoningLabel: "High",
      fastMode: false,
      profileAccentDot: {
        profileId,
        accentColor: null,
        label: "Work account",
      },
      permissionMode: null,
    });
  });

  it("keeps ambient TUI agents unbadged even when the provider has multiple profiles", () => {
    // Terminal ambient is the bare harness mark - unlike chats, which badge the
    // ambient Terminal account once 2+ profiles exist.
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
        tuiReasoningEffort: "medium",
        tuiProfileId: null,
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile("profile-1", "managed", "Work account"),
        ],
      }),
    );

    expect(view?.profileAccentDot).toBeNull();
    expect(view?.reasoningLabel).toBe("Medium");
    expect(view?.fastMode).toBe(false);
  });

  it("degrades a tombstoned/unknown TUI profile to bare harness with no badge", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
        tuiReasoningEffort: "high",
        tuiProfileId: "deleted-profile",
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile("profile-1", "managed", "Work account"),
        ],
      }),
    );

    expect(view?.profileAccentDot).toBeNull();
    expect(view?.modelLabel).toBe("Claude Sonnet 4.5");
    expect(view?.reasoningLabel).toBe("High");
  });

  it("never enables fast mode for TUI agents (no serviceTier on the record)", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
        tuiReasoningEffort: "high",
        tuiProfileId: "profile-1",
        profiles: [
          providerProfile("ambient", "ambient", "Terminal account"),
          providerProfile("profile-1", "managed", "Work account"),
        ],
      }),
    );

    expect(view?.fastMode).toBe(false);
  });

  it("falls back to the raw slug for a TUI agent when the catalog is empty", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: "sonnet-4.5",
        harnesses: [],
      }),
    );

    expect(view?.harnessName).toBe("claude");
    expect(view?.modelLabel).toBe("sonnet-4.5");
  });

  it("returns a null modelLabel for a TUI agent with no selected model", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: "claude",
        tuiModel: null,
      }),
    );

    expect(view?.modelLabel).toBeNull();
  });

  it("returns null for a chat with no persisted settings", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({ ownerKind: "chat", chatSettings: null }),
    );

    expect(view).toBeNull();
  });

  it("returns null for a terminal agent with no harness", () => {
    const view = deriveOwnerSettingsHeader(
      baseInput({
        ownerKind: "terminal-agent",
        chatSettings: null,
        tuiHarnessId: null,
        tuiModel: "sonnet-4.5",
      }),
    );

    expect(view).toBeNull();
  });
});
