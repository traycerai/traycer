import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostDirectoryEntry } from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

export function hostOption(
  hostId: string,
  name: string,
  isLocalMachine: boolean,
): HostScopeOption {
  return {
    hostId,
    name,
    isLocalMachine,
    isActive: false,
    connectable: true,
    settingUp: false,
    registered: true,
    platform: "linux",
    version: "1.0.0",
    health: {
      state: "online",
      label: "Online",
      detail: null,
      tone: "live",
      live: true,
    },
    updateState: null,
    entry: hostDirectoryEntry(hostId, name),
    item: null,
  };
}

export function managedProfile(
  profileId: string,
  label: string,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
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

export function ambientProfile(): ProviderProfile {
  return {
    ...managedProfile("ambient", "Terminal account"),
    kind: "ambient",
    profileId: "ambient",
  };
}

export function claudeProviderState(
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
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
    profiles: [...profiles],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
  };
}
