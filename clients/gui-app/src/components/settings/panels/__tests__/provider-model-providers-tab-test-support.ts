import type {
  ModelProviderEntry,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";

export const FULL_CAPS: ProviderModelProvidersCapabilities = {
  actions: ["connect", "oauth", "disconnect"],
};

export function entry(
  overrides: Partial<ModelProviderEntry>,
): ModelProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    configDeclaredCustom: false,
    custom: null,
    connected: false,
    methods: [],
    ...overrides,
  };
}
