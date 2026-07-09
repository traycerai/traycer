import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

type ProviderId = ProviderCliState["providerId"];

// Example variable name shown as the add-row placeholder, per provider, so the
// hint matches the harness being configured (illustrative only). Also read by
// `ProviderApiKeySection` for its "using X from your shell" copy.
export function envNamePlaceholder(providerId: ProviderId): string {
  switch (providerId) {
    case "claude-code":
      return "ANTHROPIC_API_KEY";
    case "codex":
      return "OPENAI_API_KEY";
    case "opencode":
    case "traycer":
      return "ANTHROPIC_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "cursor":
      return "CURSOR_API_KEY";
    case "grok":
      return "XAI_API_KEY";
    case "qwen":
      return "OPENAI_API_KEY";
    case "kiro":
      return "KIRO_API_KEY";
    case "droid":
      return "FACTORY_API_KEY";
    case "kimi":
      return "KIMI_API_KEY";
    case "copilot":
      return "COPILOT_GITHUB_TOKEN";
    case "kilocode":
      return "KILO_API_KEY";
    case "amp":
      return "AMP_API_KEY";
  }
}
