import { describe, expect, it } from "vitest";
import type { ModelProviderEntry } from "@traycer/protocol/host/provider-native-schemas";
import {
  filterModelProvidersByMethod,
  MODEL_PROVIDER_METHOD_FILTER,
  modelProviderMethodFilterLabel,
  supportsApiKeySignIn,
  supportsOauthSignIn,
} from "@/components/settings/panels/model-provider-filter";

function entry(overrides: Partial<ModelProviderEntry>): ModelProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    credentialKey: "ANTHROPIC_API_KEY",
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    connected: false,
    methods: [],
    ...overrides,
  };
}

const KEY_ONLY = entry({ id: "anthropic", name: "Anthropic" });
const OAUTH_ONLY = entry({
  id: "github-copilot",
  name: "GitHub Copilot",
  credentialKey: null,
  methods: [{ type: "oauth", label: "Sign in with GitHub", prompts: [] }],
});
const BOTH = entry({
  id: "openai",
  name: "OpenAI",
  credentialKey: "OPENAI_API_KEY",
  methods: [{ type: "oauth", label: "Sign in with OpenAI", prompts: [] }],
});
const NEITHER = entry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  credentialKey: null,
  methods: [],
});

const ALL = [KEY_ONLY, OAUTH_ONLY, BOTH, NEITHER];

describe("model provider method filter", () => {
  it("reads support off what the PROVIDER advertises", () => {
    expect(supportsOauthSignIn(OAUTH_ONLY)).toBe(true);
    expect(supportsOauthSignIn(KEY_ONLY)).toBe(false);
    expect(supportsApiKeySignIn(KEY_ONLY)).toBe(true);
    expect(supportsApiKeySignIn(OAUTH_ONLY)).toBe(false);
  });

  it("returns the SAME array while showing everything", () => {
    // The common case has to cost nothing: the catalog is ~180 rows and this
    // runs ahead of the fuzzy matcher on every keystroke.
    expect(
      filterModelProvidersByMethod(ALL, MODEL_PROVIDER_METHOD_FILTER.All),
    ).toBe(ALL);
  });

  it("narrows ~180 rows to the handful that offer a browser sign-in", () => {
    expect(
      filterModelProvidersByMethod(ALL, MODEL_PROVIDER_METHOD_FILTER.Oauth).map(
        (row) => row.id,
      ),
    ).toEqual(["github-copilot", "openai"]);
  });

  it("is NOT a partition - a provider offering both appears under either", () => {
    // The two buckets overlap on purpose. Treating them as exclusive would hide
    // a provider from the filter that describes it perfectly well.
    const apiKey = filterModelProvidersByMethod(
      ALL,
      MODEL_PROVIDER_METHOD_FILTER.ApiKey,
    ).map((row) => row.id);
    expect(apiKey).toContain("openai");
    expect(apiKey).toContain("anthropic");
  });

  it("leaves a provider offering NEITHER path out of both buckets", () => {
    // Multi-secret and service-account-file credentials: honestly unreachable
    // from here, so they match no method filter and stay findable under All.
    for (const filter of [
      MODEL_PROVIDER_METHOD_FILTER.Oauth,
      MODEL_PROVIDER_METHOD_FILTER.ApiKey,
    ] as const) {
      expect(
        filterModelProvidersByMethod(ALL, filter).map((row) => row.id),
      ).not.toContain("amazon-bedrock");
    }
    expect(
      filterModelProvidersByMethod(ALL, MODEL_PROVIDER_METHOD_FILTER.All).map(
        (row) => row.id,
      ),
    ).toContain("amazon-bedrock");
  });

  it("names every option", () => {
    expect(
      modelProviderMethodFilterLabel(MODEL_PROVIDER_METHOD_FILTER.Oauth),
    ).toBe("Browser sign-in");
    expect(
      modelProviderMethodFilterLabel(MODEL_PROVIDER_METHOD_FILTER.ApiKey),
    ).toBe("API key");
    expect(
      modelProviderMethodFilterLabel(MODEL_PROVIDER_METHOD_FILTER.All),
    ).toBe("All");
  });
});
