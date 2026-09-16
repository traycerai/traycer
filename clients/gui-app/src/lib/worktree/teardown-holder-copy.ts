import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { teardownHolderRowKey } from "@/lib/worktree/owner-teardown-snapshot";

export const UNNAMED_AGENT_FALLBACK = "This agent";

/**
 * Half A `holderId`. Used to group hold records of one actor (rule 7).
 * Absent on a pre-1.2 host.
 */
export function holderIdOf(holder: WorktreeBusyHolder): string | undefined {
  const id = holder.holderId;
  return id !== undefined && id.length > 0 ? id : undefined;
}

export function ownerNameKey(holder: WorktreeBusyHolder): string {
  return `${holder.ownerRef.ownerKind}:${holder.ownerRef.ownerId}`;
}

export function actorGroupKey(holder: WorktreeBusyHolder): string {
  const id = holderIdOf(holder);
  if (id !== undefined) return id;
  return teardownHolderRowKey(holder);
}

export interface FormattedTeardownActor {
  readonly key: string;
  readonly holderId: string | undefined;
  readonly tone: "working" | "idle";
  readonly sentence: string;
  readonly evidence: readonly string[];
  readonly holders: readonly WorktreeBusyHolder[];
}

export function formatUnknownHolderConsequence(
  worktreeIdentity: string,
): string {
  return `This host reports background work in ${worktreeIdentity}, but cannot identify it. That work will be stopped before sweeping.`;
}

export function formatUncheckedInUseKnown(processCount: number): string {
  const unit = processCount === 1 ? "process" : "processes";
  return `In use by ${String(processCount)} ${unit} · Check to review`;
}

export function formatUncheckedInUseUnknown(): string {
  return "This host reports background work here, but cannot identify it · Check to review";
}

export function formatTeardownActors(
  holders: readonly WorktreeBusyHolder[],
  agentNames: ReadonlyMap<string, string>,
): readonly FormattedTeardownActor[] {
  const groups = new Map<string, WorktreeBusyHolder[]>();
  const order: string[] = [];
  for (const holder of holders) {
    const key = actorGroupKey(holder);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [holder]);
      order.push(key);
    } else {
      existing.push(holder);
    }
  }
  return order.flatMap((key) => {
    const group = groups.get(key);
    if (group === undefined) return [];
    return [formatActorGroup(group, agentNames)];
  });
}

function formatActorGroup(
  group: readonly WorktreeBusyHolder[],
  agentNames: ReadonlyMap<string, string>,
): FormattedTeardownActor {
  const primary = worstHolder(group);
  const working = group.some((holder) => holder.activity === "working");
  const sentence = formatHolderSentence(primary, agentNames);
  const evidence: string[] = [];
  const seen = new Set<string>([sentence]);
  for (const holder of group) {
    const line = formatHolderSentence(holder, agentNames);
    if (seen.has(line)) continue;
    seen.add(line);
    evidence.push(line);
  }
  return {
    key: teardownHolderRowKey(primary),
    holderId: holderIdOf(primary),
    tone: working ? "working" : "idle",
    sentence,
    evidence,
    holders: group,
  };
}

function worstHolder(group: readonly WorktreeBusyHolder[]): WorktreeBusyHolder {
  const working = group.find((holder) => holder.activity === "working");
  return working ?? group[0];
}

export function formatHolderSentence(
  holder: WorktreeBusyHolder,
  agentNames: ReadonlyMap<string, string>,
): string {
  const name = resolveAgentName(holder, agentNames);
  if (holder.holdKind === "chat-turn") {
    if (holder.activity !== "working") {
      return `Agent “${name}” has an idle session here — will be closed`;
    }
    return formatWorkingChatSentence(name, holder.chatTier);
  }
  if (holder.holdKind === "terminal-agent-pty") {
    return holder.activity === "working"
      ? `Terminal agent “${name}” is working — will be stopped`
      : `Terminal agent “${name}” is idle — terminal will be closed`;
  }
  if (holder.holdKind === "supervised-shell") {
    const command = holder.label.trim();
    return holder.activity === "working"
      ? `Shell “${command}” is running — will be stopped`
      : `Shell “${command}” is still open — will be closed`;
  }
  return holder.activity === "working"
    ? `Agent “${name}” is still running from this worktree — will be stopped`
    : `Agent “${name}” is still running from this worktree — will be closed`;
}

/**
 * A busy chat's sentence, by WHY the host says it is busy. The tier is the
 * difference between "a turn is about to be interrupted" and "nothing is
 * mid-flight; a shell is what keeps this agent awake" - the one reading a
 * sweep dialog exists to give. Absent tier = a host that reports only the
 * boolean; say so without inventing a turn.
 */
function formatWorkingChatSentence(
  name: string,
  chatTier: WorktreeBusyHolder["chatTier"],
): string {
  switch (chatTier) {
    case "turn":
      return `Agent “${name}” is mid-turn — the turn will be stopped`;
    case "queue":
      return `Agent “${name}” has queued prompts — they will be dropped`;
    case "native-agent":
      return `Agent “${name}” has subagents running — they will be stopped`;
    case "background":
      return `Agent “${name}” is idle, kept awake by background work — that work will be stopped`;
    case undefined:
      return `Agent “${name}” has work in progress — will be stopped`;
  }
}

function resolveAgentName(
  holder: WorktreeBusyHolder,
  agentNames: ReadonlyMap<string, string>,
): string {
  const resolved = agentNames.get(ownerNameKey(holder));
  if (resolved !== undefined && resolved.length > 0) return resolved;
  const stripped = holder.label
    .replace(/\s+is (working|idle|running).*$/i, "")
    .trim();
  if (stripped.length > 0 && !isMechanismLabel(stripped)) return stripped;
  return UNNAMED_AGENT_FALLBACK;
}

function isMechanismLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return (
    normalized === "run directory" ||
    normalized === "pty" ||
    normalized === "holder" ||
    normalized === "busy"
  );
}
