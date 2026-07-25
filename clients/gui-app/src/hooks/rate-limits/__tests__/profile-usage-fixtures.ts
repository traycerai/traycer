import type {
  ProviderAuthStatus,
  ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";

export function rateLimitProviderState(
  providerId: "claude-code" | "openrouter",
  status: ProviderAuthStatus,
): ProviderCliState {
  return {
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
    providerId,
    auth: {
      status,
      badgeText: null,
      label: null,
      detail: null,
    },
    profiles: [],
  };
}
