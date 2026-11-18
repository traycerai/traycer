import { describe, expect, it } from "vitest";
import type { ModelProviderEntry } from "@traycer/protocol/host/provider-native-schemas";
import {
  filterModelProvidersByMethod,
  MODEL_PROVIDER_METHOD_FILTER,
  MODEL_PROVIDER_METHOD_FILTER_OPTIONS,
  modelProviderMethodFilterLabel,
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
    expect(supportsOauthSignIn(BOTH)).toBe(true);
    expect(supportsOauthSignIn(NOTHING_OFFERED)).toBe(false);
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

  it("offers no API-key bucket, because it would be the whole catalog", () => {
    // The host synthesizes an `api` method for every provider whose
    // `/provider/auth` advertises nothing, which puts 178 of ~180 rows in that
    // bucket. A control that costs a click and returns the list you were
    // already looking at is a dead option, and the two rows it would exclude
    // are the ones "Browser sign-in" already isolates.
    expect(
      MODEL_PROVIDER_METHOD_FILTER_OPTIONS.map((option) => option.value),
    ).toEqual(["all", "oauth"]);
  });

  it("names every option", () => {
    expect(
      modelProviderMethodFilterLabel(MODEL_PROVIDER_METHOD_FILTER.Oauth),
    ).toBe("Browser sign-in");
    expect(
      modelProviderMethodFilterLabel(MODEL_PROVIDER_METHOD_FILTER.All),
    ).toBe("All");
  });
});
