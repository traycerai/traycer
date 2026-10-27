import { PROVIDER_DISPLAY_NAMES, type ProviderId } from "./provider-schemas";

/** Recognizable issuers, never a list of required formats for a target. */
const API_KEY_ISSUERS = [
  // https://platform.claude.com/docs/en/manage-claude/authentication
  { providerId: "claude-code", label: "Anthropic", prefix: "sk-ant-" },
  // https://openrouter.ai/docs/api/api-reference/o-auth/exchange-auth-code-for-api-key
  { providerId: "openrouter", label: "OpenRouter", prefix: "sk-or-" },
  // https://huggingface.co/docs/hub/security-tokens
  { providerId: "huggingface", label: "Hugging Face", prefix: "hf_" },
  // https://github.com/Factory-AI/factory/blob/main/docs/reference/cli-reference.mdx
  { providerId: "droid", label: "Factory", prefix: "fk-" },
  // https://ampcode.com/docs/cli/spawning-orbs
  { providerId: "amp", label: "Amp", prefix: "sgamp_" },
] as const;

/**
 * Refuse only a positively recognizable foreign issuer. Unknown shapes stay
 * accepted so a vendor changing its format cannot lock out a legitimate key.
 * No key material is included in the refusal.
 */
export function providerApiKeyRefusal(
  providerId: ProviderId,
  value: string,
): string | null {
  const trimmed = value.trim();
  const issuer = API_KEY_ISSUERS.find(
    (row) =>
      trimmed.startsWith(row.prefix) && trimmed.length > row.prefix.length,
  );
  if (issuer === undefined || issuer.providerId === providerId) return null;
  const article = /^[AEIOU]/.test(issuer.label) ? "an" : "a";
  return `That looks like ${article} ${issuer.label} key. Use your ${PROVIDER_DISPLAY_NAMES[providerId]} key.`;
}
