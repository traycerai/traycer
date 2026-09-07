import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

type ProviderId = ProviderCliState["providerId"];

// Example variable name shown as the add-row placeholder, per provider, so the hint matches the harness being
// configured (illustrative only).
const ENV_NAME_PLACEHOLDER: Record<ProviderId, string> = {
  "claude-code": "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  opencode: "ANTHROPIC_API_KEY",
  traycer: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  huggingface: "HF_TOKEN",
  cursor: "CURSOR_API_KEY",
  grok: "XAI_API_KEY",
  qwen: "OPENAI_API_KEY",
  kiro: "KIRO_API_KEY",
  droid: "FACTORY_API_KEY",
  kimi: "KIMI_API_KEY",
  copilot: "COPILOT_GITHUB_TOKEN",
  kilocode: "KILO_API_KEY",
  amp: "AMP_API_KEY",
  devin: "WINDSURF_API_KEY",
  pi: "ANTHROPIC_API_KEY",
  // Hermes is subscription/credential-store class; the env name is
  // illustrative only (Hermes drives provider accounts such as OpenRouter).
  hermes: "OPENROUTER_API_KEY",
  // omp aggregates several provider subscriptions/keys (Anthropic, OpenAI, OpenRouter,...) in its own credential
  // store; the env name is illustrative only, same as Hermes above.
  omp: "OPENROUTER_API_KEY",
  // Reasonix names a different env var per configured provider - the config's `api_key_env` key chooses it, and
  // the value lives in Reasonix's own global `.env`, not in the shell.
  reasonix: "DEEPSEEK_API_KEY",
};

export function envNamePlaceholder(providerId: ProviderId): string {
  return ENV_NAME_PLACEHOLDER[providerId];
}
