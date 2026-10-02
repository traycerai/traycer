import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

/**
 * The harness id each provider is known by on the agent-facing surfaces
 * (`traycer agent create --harness`, the GUI harness picker). The two id
 * spaces differ for exactly one provider today (`claude-code` / `claude`), but
 * the table is total so a new provider is a compile error here rather than a
 * silent miss in one client.
 *
 * One table for the GUI and the CLI: both name providers to the user by
 * harness id and address the host's `providers.*` methods by provider id.
 */
export const GUI_HARNESS_BY_PROVIDER_ID = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
  traycer: "traycer",
  openrouter: "openrouter",
  huggingface: "huggingface",
  droid: "droid",
  cursor: "cursor",
  copilot: "copilot",
  grok: "grok",
  kiro: "kiro",
  kilocode: "kilocode",
  kimi: "kimi",
  qwen: "qwen",
  antigravity: "antigravity",
  amp: "amp",
  devin: "devin",
  pi: "pi",
  hermes: "hermes",
  omp: "omp",
  reasonix: "reasonix",
} satisfies Readonly<Record<ProviderId, GuiHarnessId>>;

/**
 * The provider a user-typed name refers to: a harness id (`claude`) or the
 * provider id itself (`claude-code`). Null when it names neither.
 */
export function providerIdFromHarnessOrProviderName(
  name: string,
): ProviderId | null {
  if (isProviderId(name)) return name;
  for (const providerId of Object.keys(GUI_HARNESS_BY_PROVIDER_ID)) {
    if (
      isProviderId(providerId) &&
      GUI_HARNESS_BY_PROVIDER_ID[providerId] === name
    ) {
      return providerId;
    }
  }
  return null;
}

function isProviderId(key: string): key is ProviderId {
  return Object.hasOwn(GUI_HARNESS_BY_PROVIDER_ID, key);
}
