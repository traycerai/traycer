import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfilePersonNotice,
} from "@traycer/protocol/host/provider-schemas";
import type { RemovedProviderProfile } from "@/components/providers/provider-profile-model";

const AUTHENTICATED: ProviderAuth = {
  status: "authenticated",
  badgeText: null,
  label: null,
  detail: null,
};

/** A profile row with none of the 10.11 keys set, as a 10.10 computer sends it. */
export function legacyProfile(input: {
  readonly profileId: string;
  readonly label: string;
  readonly kind: "ambient" | "managed";
  readonly enabled: boolean;
  readonly authStatus: ProviderAuth["status"];
}): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: input.enabled,
    kind: input.kind,
    authType: "oauth",
    label: input.label,
    auth: {
      status: input.authStatus,
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

/** A 10.11 row. Pass an empty list or `null` for a key the computer did not set. */
export function pinProfile(input: {
  readonly profileId: string;
  readonly label: string;
  readonly kind: "ambient" | "managed";
  readonly enabled: boolean;
  readonly authStatus: ProviderAuth["status"];
  readonly aliases: readonly string[];
  readonly personNotice: ProviderProfilePersonNotice | null;
  readonly terminalOnThisComputer: boolean;
  readonly otherNames: readonly string[];
}): ProviderProfile {
  return {
    ...legacyProfile(input),
    aliases: [...input.aliases],
    personNotice: input.personNotice,
    terminalOnThisComputer: input.terminalOnThisComputer,
    otherNames: [...input.otherNames],
  };
}

export function removedEntry(input: {
  readonly providerId: string;
  readonly profileId: string;
  readonly aliases: readonly string[];
}): RemovedProviderProfile {
  return {
    providerId: input.providerId,
    profileId: input.profileId,
    aliases: [...input.aliases],
  };
}

export function providerState(input: {
  readonly providerId: ProviderId;
  readonly authStatus: ProviderAuth["status"];
  readonly profiles: readonly ProviderProfile[];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: input.authStatus,
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
    profiles: [...input.profiles],
  };
}

export const SIGNED_IN: ProviderAuth = AUTHENTICATED;
