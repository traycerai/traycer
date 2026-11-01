import { describe, expect, it } from "vitest";

import { providerApiKeyRefusal } from "../provider-api-key-issuer";
import type { ProviderId } from "../provider-ids";

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

// Targets whose own key shape is in the issuer table: the refusal names it.
const KNOWN_SHAPE_TARGETS = [
  [
    "openrouter",
    'This looks like an Anthropic key, not an OpenRouter key. OpenRouter keys start with "sk-or-".',
  ],
  [
    "huggingface",
    'This looks like an Anthropic key, not a Hugging Face key. Hugging Face keys start with "hf_".',
  ],
  [
    "droid",
    'This looks like an Anthropic key, not a Droid key. Droid keys start with "fk-".',
  ],
  [
    "amp",
    'This looks like an Anthropic key, not an Amp key. Amp keys start with "sgamp_".',
  ],
] as const satisfies readonly (readonly [ProviderId, string])[];

// Targets with no known shape of their own: the refusal names only the
// vendor it found, since there is no shape to name for the target.
const UNKNOWN_SHAPE_TARGETS = [
  ["cursor", "This looks like an Anthropic key, not a Cursor key."],
  ["kiro", "This looks like an Anthropic key, not a Kiro key."],
] as const satisfies readonly (readonly [ProviderId, string])[];

describe("providerApiKeyRefusal", () => {
  it.each(KNOWN_SHAPE_TARGETS)(
    "refuses an Anthropic-shaped key for %s, naming the vendor, the target and the target's shape",
    (providerId, refusal) => {
      expect(providerApiKeyRefusal(providerId, KEYS.anthropic)).toBe(refusal);
    },
  );

  it.each(UNKNOWN_SHAPE_TARGETS)(
    "refuses an Anthropic-shaped key for %s, with no shape of its own to name",
    (providerId, refusal) => {
      expect(providerApiKeyRefusal(providerId, KEYS.anthropic)).toBe(refusal);
    },
  );

  it.each([
    ["openrouter", KEYS.openrouter, "an OpenRouter"],
    ["huggingface", KEYS.huggingface, "a Hugging Face"],
    ["droid", KEYS.factory, "a Factory"],
    ["amp", KEYS.amp, "an Amp"],
  ] as const)(
    "refuses a %s-shaped key pasted into a target with no shape of its own, with the right article",
    (_issuer, key, phrase) => {
      expect(providerApiKeyRefusal("cursor", key)).toBe(
        `This looks like ${phrase} key, not a Cursor key.`,
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
