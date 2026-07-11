import type {
  AgentSender,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
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

export function agentModelKey(
  provider: AgentSender["harnessId"],
  model: string,
): string {
  return `${provider}:${model}`;
}

export function resolveSenderLabel(
  sender: UserMessageSender,
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
  sender: AgentSender,
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
  sender: AgentSender,
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
  sender: AgentSender,
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
  sender: AgentSender,
  context: SenderDisplayContext,
): string | undefined {
  if (sender.displayName === null) return undefined;
  return context.modelLabels.get(
    agentModelKey(sender.harnessId, sender.displayName),
  );
}

function reasoningLabelForModel(
  provider: GuiHarnessId,
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
};

function agentProviderLabel(provider: GuiHarnessId): string {
  return AGENT_PROVIDER_LABEL[provider];
}
