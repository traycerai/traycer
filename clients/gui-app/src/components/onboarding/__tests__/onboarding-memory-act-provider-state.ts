import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/** One provider as a test host lists it. */
export interface ProviderSpec {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly nativeMemory: boolean;
}

/** The host's `providers.list` row for a spec. */
export function providerState(spec: ProviderSpec): ProviderCliState {
  return {
    providerId: spec.providerId,
    enabled: spec.enabled,
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
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    nativeMemory: spec.nativeMemory,
    nativeMemorySupported: spec.supported,
  };
}
