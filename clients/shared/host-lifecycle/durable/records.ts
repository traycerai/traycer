// Versioned durable-record payload shapes owned by the lifecycle layer.
// Decoders in `decoder.ts` are total over raw bytes; these types describe only the *valid* arms.

/** `substrate.json` - active registration substrate (macOS dual-substrate). */
import type { TransitionPhase } from "../transition/types";
export type SubstrateRecord = {
  readonly active: "smappservice" | "raw-fallback";
  readonly since: string;
  readonly reason: string;
  readonly attestation: string | null;
};

export type TransitionJournal = {
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly from: "smappservice" | "raw-fallback";
  readonly to: "smappservice" | "raw-fallback";
  readonly phase: TransitionPhase;
  readonly expectedIdentities: readonly string[];
  readonly compensation: string | null;
  readonly startedAt: string;
  readonly governor: TransitionGovernor | null;
};

// Three decoders for one file is how the shapes drift apart; this was the one with no callers.

export type TransitionGovernor = {
  readonly lastAttemptedBuildId: string | null;
  readonly lastAttemptedCDHash: string | null;
  readonly failureClass: string | null;
  readonly attemptCount: number;
  readonly nextEligibleAt: string | null;
  readonly breaker: string | null;
  readonly lastSustainedHealthAt: string | null;
};

/**
 * Minimal install record projection for the world probe.
 * Full install schema remains owned by the CLI installer; we only require the fields the planner needs for generation / version identity.
 */
export type InstallRecord = {
  readonly version: string;
  readonly installedAt: string;
  readonly installId: string | null;
  readonly archiveSha256: string | null;
  readonly platform: string | null;
  readonly arch: string | null;
};

export type PendingActivation = {
  readonly toGeneration: string;
  readonly requestedAt: string;
  readonly cause: string;
};

export const SUBSTRATE_SUPPORTED_VERSIONS: readonly number[] = [1];
/**
 * The version substrate writers emit.
 * The load-time guard below preserves the old derivation's one guarantee: a writer can never mint a `v` the local decoder refuses.
 */
export const SUBSTRATE_RECORD_WRITE_VERSION: number = 1;
if (!SUBSTRATE_SUPPORTED_VERSIONS.includes(SUBSTRATE_RECORD_WRITE_VERSION)) {
  throw new Error(
    `SUBSTRATE_RECORD_WRITE_VERSION (${String(SUBSTRATE_RECORD_WRITE_VERSION)}) is not in SUBSTRATE_SUPPORTED_VERSIONS`,
  );
}
export const TRANSITION_SUPPORTED_VERSIONS: readonly number[] = [1];
export const ACTIVATION_JOURNAL_SUPPORTED_VERSIONS: readonly number[] = [1];
export const INSTALL_SUPPORTED_VERSIONS: readonly number[] = [1];
export const PENDING_ACTIVATION_SUPPORTED_VERSIONS: readonly number[] = [1];
