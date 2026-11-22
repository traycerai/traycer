import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

export function apiKeyState(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "path" },
    candidates: [],
    auth: {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    profiles: [],
  };
}

export function storedApiKeyState(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    ...apiKeyState(providerId),
    apiKey: { supported: true, configured: true, source: "stored" },
  };
}
