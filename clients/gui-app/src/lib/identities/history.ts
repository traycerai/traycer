/**
 * Pure halves of the identity history panel: provenance labels, the copy for
 * a restore the host cannot perform, and the page merge.
 */
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { AgentIdentityVersionEntry } from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";

type RestoreUnavailableReason = Extract<
  ResponseOfMethod<HostRpcRegistry, "agentIdentity.history.restore">,
  { kind: "unavailable" }
>["reason"];

export const IDENTITY_PROVENANCE_LABELS: Readonly<
  Record<AgentIdentityVersionEntry["provenance"]["kind"], string>
> = {
  agent: "Agent edit",
  user_session: "Your edit",
  multiple_agents: "Several agents",
  external: "External edit",
  system: "System capture",
  remote_merge: "Remote merge",
  restore: "Restored version",
  revive: "Restored file",
  delete: "Deleted",
  clobber: "Recovered overwrite",
  evolution: "Evolution pass",
};

export const RESTORE_UNAVAILABLE_COPY: Readonly<
  Record<RestoreUnavailableReason, string>
> = {
  storage_full: "The host is out of space for history.",
  journal_cap: "This file's history is full; the host can't record a restore.",
  target_not_found: "That version is no longer on the host.",
  missing_blob: "That version's bytes are missing on the host.",
  artifact_not_live: "This file is no longer live, so it can't be restored.",
  kind_mismatch: "That version isn't the same kind of file as the current one.",
  body_unavailable: "The host can't read this file's body right now.",
  missing_images: "That version references images the host no longer has.",
};

/** Newest first, one row per observation id; the query's page wins on a tie. */
export function mergeIdentityHistoryPages(
  latest: readonly AgentIdentityVersionEntry[],
  older: readonly AgentIdentityVersionEntry[],
): readonly AgentIdentityVersionEntry[] {
  const seen = new Set<string>();
  const merged: AgentIdentityVersionEntry[] = [];
  for (const entry of [...latest, ...older]) {
    if (seen.has(entry.observationId)) continue;
    seen.add(entry.observationId);
    merged.push(entry);
  }
  return merged;
}
