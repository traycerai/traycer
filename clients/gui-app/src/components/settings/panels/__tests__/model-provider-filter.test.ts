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
    configDeclaredCustom: false,
    custom: null,
    connected: false,
    // What the host really sends for a provider whose `/provider/auth`
    // advertises nothing: it synthesizes this generic key method itself.
    methods: [{ type: "api", label: "API key", prompts: [] }],
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
// An EMPTY method list now means the host offered nothing at all - not the
// common "advertises nothing upstream" case, which arrives carrying the host's
// synthesized key method. It belongs in neither bucket.
const NOTHING_OFFERED = entry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  methods: [],
});

const ALL = [KEY_ONLY, OAUTH_ONLY, BOTH, NOTHING_OFFERED];

describe("model provider method filter", () => {
  it("reads support off what the PROVIDER advertises", () => {
    expect(supportsOauthSignIn(OAUTH_ONLY)).toBe(true);
    expect(supportsOauthSignIn(KEY_ONLY)).toBe(false);
    // The common case reaches this through the host's synthesized key method,
    // the same branch a real advertised key arm takes.
    expect(supportsApiKeySignIn(KEY_ONLY)).toBe(true);
    // Excluded: a method list with no key arm, and a row the host offered
    // nothing for at all.
    expect(supportsApiKeySignIn(OAUTH_ONLY)).toBe(false);
    expect(supportsApiKeySignIn(NOTHING_OFFERED)).toBe(false);
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

  it("excludes rows with no key arm - advertised or synthesized", () => {
    // `github-copilot` advertises `['oauth']` and nothing else; the bedrock
    // fixture stands for a row the host offered nothing for. Neither has a key
    // path, so neither belongs in the bucket.
    const apiKey = filterModelProvidersByMethod(
      ALL,
      MODEL_PROVIDER_METHOD_FILTER.ApiKey,
    ).map((row) => row.id);
    expect(apiKey).not.toContain("github-copilot");
    expect(apiKey).not.toContain("amazon-bedrock");
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
