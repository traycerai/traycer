import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { ProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";

export function profile(input: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
  readonly rateLimitLimitedScopes: ProviderProfile["rateLimitLimitedScopes"];
  readonly authenticated: boolean;
}): ProviderProfile {
  const {
    profileId,
    kind,
    label,
    rateLimitStatus,
    rateLimitLimitedScopes,
    authenticated,
  } = input;
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: authenticated ? "authenticated" : "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

export function model(slug: string, label: string): ModelOption {
  return {
    harnessId: "claude",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

export const OPUS = model("opus[1m]", "Opus");

export function visiblePrompt(prompt: ProfileRateLimitSwitchPrompt) {
  if (prompt.kind !== "visible") {
    throw new Error("Expected a visible rate-limit switch prompt");
  }
  return prompt;
}

export function claudeState(
  profiles: ReadonlyArray<ProviderProfile>,
): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
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
    profiles: [...profiles],
  };
}
