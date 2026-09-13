import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";

/**
 * Which of the automatic-cleanup card's five states applies.
 *
 * A pure function, in its own module, so the ladder is testable without a host
 * — and so "old host" can never be mistaken for "offline host". Those two call
 * for different actions (update it / start it) and only one of them is a claim
 * about the host's version.
 */
export type AutoCleanupGate =
  | "absent"
  | "checking"
  | "offline"
  | "unsupported"
  | "ready";

export function resolveAutoCleanupGate(input: {
  readonly hostId: string | null;
  readonly scopeUsable: boolean;
  readonly reachabilityStatus: HostReachabilityStatus;
  readonly hasClient: boolean;
  /** Tri-state: `null` is "no handshake yet", never "absent". */
  readonly supported: boolean | null;
}): AutoCleanupGate {
  // No resolved host, or a scope with nothing behind it: the inventory's own
  // `HostScopeGate` names that state one card below. A second copy of it here
  // would be two answers to one question.
  if (input.hostId === null || !input.scopeUsable) return "absent";
  if (
    input.reachabilityStatus === "checking" ||
    input.reachabilityStatus === "host-starting"
  ) {
    return "checking";
  }
  if (input.reachabilityStatus !== "reachable" || !input.hasClient) {
    return "offline";
  }
  // Fails OPEN into "checking", not into "unsupported": telling someone their
  // host is too old because no handshake has completed yet is a claim about a
  // fact not in evidence, and it self-heals silently the wrong way round.
  if (input.supported === null) return "checking";
  if (!input.supported) return "unsupported";
  return "ready";
}
