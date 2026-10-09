// The OPEN sender shapes: `chat.subscribe@1.22` carries a heard-from harness
// id as written, so a row's sender may name a harness this build does not
// know. Every closed sender is assignable to its open shape, so callers that
// build one from the chat's own settings pass unchanged.
import type {
  OpenAgentSender,
  OpenUserMessageSender,
} from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { EpicCollaboratorView } from "@/hooks/epics/use-epic-collaborators-query";
import type { GuiHarnessId } from "@traycer/protocol/host";

export interface SenderDisplayContext {
  readonly profile: AuthProfile | null;
  readonly collaborators: ReadonlyArray<EpicCollaboratorView>;
  readonly modelLabels: ReadonlyMap<string, string>;
  readonly modelReasoningLabels: ReadonlyMap<
    string,
    ReadonlyMap<string, string>
  >;
}

export function agentModelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function resolveSenderLabel(
  sender: OpenUserMessageSender,
  context: SenderDisplayContext,
): string {
  if (sender.type === "agent") {
    return sender.displayName ?? sender.agentId;
  }
  if (context.profile?.userId === sender.userId) return "You";
  return (
    context.collaborators.find(
      (collaborator) => collaborator.userId === sender.userId,
    )?.displayName ?? sender.userId
  );
}

export interface AgentSenderDisplay {
  /** Friendly provider label, e.g. "Claude Code". */
  readonly providerLabel: string;
  /** Resolved model label, or `null` when the sender carries no model. */
  readonly modelLabel: string | null;
}

export function resolveAgentSenderDisplay(
  sender: OpenAgentSender,
  context: SenderDisplayContext,
): AgentSenderDisplay {
  const providerLabel = agentProviderLabel(sender.harnessId);
  const modelLabel = agentModelLabel(sender, providerLabel, context);
  return {
    providerLabel,
    modelLabel: modelLabel.length === 0 ? null : modelLabel,
  };
}

export function resolveAgentReasoningLabel(
  sender: OpenAgentSender,
  reasoningEffort: string | null,
  context: SenderDisplayContext,
): string | null {
  const normalized = normalizeReasoningEffort(reasoningEffort);
  if (normalized === null) return null;
  const modelLabel = reasoningLabelForModel(
    sender.harnessId,
    sender.agentId,
    normalized,
    context,
  );
  if (modelLabel !== null) return modelLabel;
  if (sender.displayName !== null) {
    const displayNameLabel = reasoningLabelForModel(
      sender.harnessId,
      sender.displayName,
      normalized,
      context,
    );
    if (displayNameLabel !== null) return displayNameLabel;
  }
  return normalized;
}

function agentModelLabel(
  sender: OpenAgentSender,
  providerLabel: string,
  context: SenderDisplayContext,
): string {
  const catalogLabel =
    context.modelLabels.get(agentModelKey(sender.harnessId, sender.agentId)) ??
    modelLabelFromDisplayName(sender, context);
  if (catalogLabel !== undefined) return catalogLabel;
  if (sender.displayName !== null && sender.displayName !== providerLabel) {
    return sender.displayName;
  }
  if (sender.agentId === sender.harnessId || sender.agentId === providerLabel) {
    return "";
  }
  return sender.agentId;
}

function modelLabelFromDisplayName(
  sender: OpenAgentSender,
  context: SenderDisplayContext,
): string | undefined {
  if (sender.displayName === null) return undefined;
  return context.modelLabels.get(
    agentModelKey(sender.harnessId, sender.displayName),
  );
}

function reasoningLabelForModel(
  provider: string,
  model: string,
  reasoningEffort: string,
  context: SenderDisplayContext,
): string | null {
  return (
    context.modelReasoningLabels
      .get(agentModelKey(provider, model))
      ?.get(reasoningEffort) ?? null
  );
}

function normalizeReasoningEffort(
  reasoningEffort: string | null,
): string | null {
  if (reasoningEffort === null) return null;
  const trimmed = reasoningEffort.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Exhaustive Record over GuiHarnessId: a new harness id fails to compile
// instead of silently mislabeling.
const AGENT_PROVIDER_LABEL: Record<GuiHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  traycer: "Traycer",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
  cursor: "Cursor",
  grok: "Grok",
  qwen: "Qwen Code",
  kiro: "Kiro",
  droid: "Droid",
  kimi: "Kimi",
  copilot: "Copilot",
  kilocode: "Kilo Code",
  amp: "Amp",
  devin: "Devin",
  pi: "Pi",
  hermes: "Hermes Agent",
  omp: "Oh My Pi",
  reasonix: "Reasonix",
  antigravity: "Antigravity",
  commandcode: "Command Code",
};

function isKnownProvider(provider: string): provider is GuiHarnessId {
  return Object.hasOwn(AGENT_PROVIDER_LABEL, provider);
}

/**
 * A known harness gets its label; an unknown one (a sender on a harness this
 * build predates, decoded as written on `chat.subscribe@1.22`) gets its raw id.
 * The raw id is the honest answer: never another provider's name, never a
 * blank "Provider" row.
 */
export function agentProviderLabel(provider: string): string {
  return isKnownProvider(provider) ? AGENT_PROVIDER_LABEL[provider] : provider;
}

/**
 * The harness id as this build knows it, or `null` for one it does not: the
 * narrowing a DRIVE affordance needs (open that provider's settings, continue
 * a subagent on that harness) when its input is a heard-from id off a `1.22`
 * row. `null` is the affordance's own "no harness in hand" branch, never a
 * substitute provider.
 */
export function knownHarnessId(provider: string): GuiHarnessId | null {
  return isKnownProvider(provider) ? provider : null;
}
