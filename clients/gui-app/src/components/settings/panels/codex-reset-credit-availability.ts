import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

export function canUseCodexResetCredit(
  providerId: ProviderId,
  enabled: boolean,
): boolean {
  return enabled && providerId === "codex";
}
