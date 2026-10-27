import { describe, expect, it } from "vitest";

import { providerApiKeyRefusal } from "../provider-api-key-issuer";
import type { ProviderId } from "../provider-ids";
import { PROVIDER_DISPLAY_NAMES } from "../provider-schemas";

// The providers whose API key the settings form takes. Fake strings only: each
// carries a vendor's documented prefix and nothing else.
const KEY_PROVIDERS = [
  "cursor",
  "kiro",
  "droid",
  "openrouter",
  "huggingface",
  "amp",
] as const satisfies readonly ProviderId[];

const KEYS = {
  anthropic: "sk-ant-api03-clearly-fake-test-key-do-not-use",
  openrouter: "sk-or-v1-clearly-fake-test-key-do-not-use",
  huggingface: "hf_clearly-fake-test-key-do-not-use",
  factory: "fk-clearly-fake-test-key-do-not-use",
  amp: "sgamp_clearly-fake-test-key-do-not-use",
} as const;

const UNKNOWN_KEY = "unrecognized-shape-fake-key-do-not-use";

describe("providerApiKeyRefusal", () => {
  it.each(KEY_PROVIDERS)(
    "refuses an Anthropic-shaped key for %s, naming the vendor and the target",
    (providerId) => {
      expect(providerApiKeyRefusal(providerId, KEYS.anthropic)).toBe(
        `That looks like an Anthropic key. Use your ${PROVIDER_DISPLAY_NAMES[providerId]} key.`,
      );
    },
  );

  it.each([
    ["openrouter", KEYS.openrouter, "an OpenRouter"],
    ["huggingface", KEYS.huggingface, "a Hugging Face"],
    ["droid", KEYS.factory, "a Factory"],
    ["amp", KEYS.amp, "an Amp"],
  ] as const)(
    "refuses a %s-shaped key pasted into a different provider, with the right article",
    (_issuer, key, phrase) => {
      expect(providerApiKeyRefusal("cursor", key)).toBe(
        `That looks like ${phrase} key. Use your ${PROVIDER_DISPLAY_NAMES.cursor} key.`,
      );
    },
  );

  it.each([
    ["openrouter", KEYS.openrouter],
    ["huggingface", KEYS.huggingface],
    ["droid", KEYS.factory],
    ["amp", KEYS.amp],
  ] as const)("accepts %s's own key shape", (providerId, key) => {
    expect(providerApiKeyRefusal(providerId, key)).toBeNull();
  });

  it.each(KEY_PROVIDERS)(
    "accepts a key of no recognizable shape for %s",
    (id) => {
      expect(providerApiKeyRefusal(id, UNKNOWN_KEY)).toBeNull();
    },
  );

  it("matches on the trimmed value", () => {
    expect(
      providerApiKeyRefusal("openrouter", `  ${KEYS.anthropic}\n`),
    ).not.toBeNull();
    expect(
      providerApiKeyRefusal("openrouter", `  ${KEYS.openrouter}\n`),
    ).toBeNull();
  });

  it("accepts an empty value and a bare prefix with nothing after it", () => {
    expect(providerApiKeyRefusal("openrouter", "")).toBeNull();
    expect(providerApiKeyRefusal("openrouter", "   ")).toBeNull();
    expect(providerApiKeyRefusal("openrouter", "sk-ant-")).toBeNull();
  });
});
