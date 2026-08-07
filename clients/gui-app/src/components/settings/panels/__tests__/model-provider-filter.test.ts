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
  methods: [{ type: "oauth", label: "Sign in with GitHub", prompts: [] }],
});
const BOTH = entry({
  id: "openai",
  name: "OpenAI",
  methods: [
    { type: "oauth", label: "Sign in with OpenAI", prompts: [] },
    { type: "api", label: "Manually enter API Key", prompts: [] },
  ],
});
// No longer a "neither" case: a provider advertising nothing now gets the
// synthesized plain-key path like every other. Kept as the ADVERTISES-NOTHING
// fixture, which is what the api-key bucket is mostly made of.
const NO_METHODS = entry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  methods: [],
});

const ALL = [KEY_ONLY, OAUTH_ONLY, BOTH, NO_METHODS];

describe("model provider method filter", () => {
  it("reads support off what the PROVIDER advertises", () => {
    expect(supportsOauthSignIn(OAUTH_ONLY)).toBe(true);
    expect(supportsOauthSignIn(KEY_ONLY)).toBe(false);
    // Advertising nothing means the synthesized plain-key path applies, which
    // is what makes this the common case rather than an exception.
    expect(supportsApiKeySignIn(KEY_ONLY)).toBe(true);
    expect(supportsApiKeySignIn(NO_METHODS)).toBe(true);
    // The one kind excluded: a provider that advertised a method list with no
    // key arm in it.
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
    expect(apiKey).toContain("amazon-bedrock");
  });

  it("excludes only the providers that advertised a key-less method list", () => {
    // `github-copilot` advertises `['oauth']` and nothing else. Everything else
    // reaches the key bucket, which is the point of deleting the classifier
    // that used to decide otherwise.
    expect(
      filterModelProvidersByMethod(
        ALL,
        MODEL_PROVIDER_METHOD_FILTER.ApiKey,
      ).map((row) => row.id),
    ).not.toContain("github-copilot");
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
