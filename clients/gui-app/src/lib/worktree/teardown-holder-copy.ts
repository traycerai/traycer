import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { HOLDERS_REVISION_DIGEST_PATTERN } from "@traycer/protocol/host/worktree-schemas";
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

/**
 * Echo-able digest. Empty, missing, or malformed values cannot form
 * consent — Sweep then uses today's `stopOwners` path and the unknown
 * consequence line.
 */
export function sanitizeHoldersRevision(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return HOLDERS_REVISION_DIGEST_PATTERN.test(value) ? value : undefined;
}

export function ownerNameKey(holder: WorktreeBusyHolder): string {
  return `${holder.ownerRef.ownerKind}:${holder.ownerRef.ownerId}`;
}

export function actorGroupKey(holder: WorktreeBusyHolder): string {
  const id = holderIdOf(holder);
  if (id !== undefined) return id;
  return teardownHolderRowKey(holder);
}

export function canSubmitExpectedHoldersRevision(
  revision: string | undefined,
): boolean {
  return sanitizeHoldersRevision(revision) !== undefined;
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

export function formatStopHeading(input: {
  readonly knownActors: number;
  readonly unknownRows: number;
}): string {
  if (input.unknownRows > 0 && input.knownActors === 0) {
    return "Unidentified background work will be stopped";
  }
  if (input.unknownRows > 0) {
    const unit = input.knownActors === 1 ? "process" : "processes";
    return `${String(input.knownActors)} ${unit} will be stopped, and unidentified background work`;
  }
  const unit = input.knownActors === 1 ? "process" : "processes";
  return `${String(input.knownActors)} ${unit} will be stopped`;
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
    return holder.activity === "working"
      ? `Agent “${name}” is working on a turn — will be stopped`
      : `Agent “${name}” has an idle session here — will be closed`;
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
