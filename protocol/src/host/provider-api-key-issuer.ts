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

function article(label: string): string {
  return /^[AEIOU]/.test(label) ? "an" : "a";
}

/**
 * Refuse only a positively recognizable foreign issuer. Unknown shapes stay
 * accepted so a vendor changing its format cannot lock out a legitimate key.
 * No key material is included in the refusal. Names the target's own prefix
 * too, for a target in `API_KEY_ISSUERS`; a target with no known shape gets
 * only the first sentence, since there is no shape to name.
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
  const targetLabel = PROVIDER_DISPLAY_NAMES[providerId];
  const target = API_KEY_ISSUERS.find((row) => row.providerId === providerId);
  const shapeClause =
    target === undefined
      ? ""
      : ` ${targetLabel} keys start with "${target.prefix}".`;
  return `This looks like ${article(issuer.label)} ${issuer.label} key, not ${article(targetLabel)} ${targetLabel} key.${shapeClause}`;
}
