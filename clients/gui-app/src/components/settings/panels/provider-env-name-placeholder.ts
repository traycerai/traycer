import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

type ProviderId = ProviderCliState["providerId"];

// Example variable name shown as the add-row placeholder, per provider, so the
// hint matches the harness being configured (illustrative only). Also read by
// `ProviderApiKeySection` for its "using X from your shell" copy.
// PI is BYOK; final auth UX is host-side — `ANTHROPIC_API_KEY` is a temporary
// placeholder only.
const ENV_NAME_PLACEHOLDER: Record<ProviderId, string> = {
  "claude-code": "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  opencode: "ANTHROPIC_API_KEY",
  traycer: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
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
};

export function envNamePlaceholder(providerId: ProviderId): string {
  return ENV_NAME_PLACEHOLDER[providerId];
}
