// Versioned durable-record payload shapes owned by the lifecycle layer.
// Decoders in `decoder.ts` are total over raw bytes; these types describe
// only the *valid* arms. Planner (T4) / transition (T6) / activation (T7)
// own semantics — T3 only decodes.

/** `substrate.json` — active registration substrate (macOS dual-substrate). */
export type SubstrateRecord = {
  readonly active: "smappservice" | "raw-fallback";
  readonly since: string;
  readonly reason: string;
  readonly attestation: string | null;
};

/**
 * Transition journal payload (F2 / F5). T3 decodes structure only; phase
 * machinery is T6.
 */
export type TransitionJournal = {
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly from: "smappservice" | "raw-fallback";
  readonly to: "smappservice" | "raw-fallback";
  readonly phase: string;
  readonly expectedIdentities: readonly string[];
  readonly compensation: string | null;
  readonly startedAt: string;
  readonly governor: TransitionGovernor | null;
};

// `ActivationJournal` + `decodeActivationJournal` lived here and were dead:
// no probe decoded an activation journal, no test exercised them, and only the
// barrel re-exported them — while `activation/types.ts`'s
// `LifecycleActivationJournal` and the CLI's `parseActivationJournal` each
// defined a competing shape for the same file. Three decoders for one file is
// how the shapes drift apart; this was the one with no callers.

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
 * Minimal install record projection for the world probe. Full install
 * schema remains owned by the CLI installer; we only require the fields
 * the planner needs for generation / version identity.
 */
export type InstallRecord = {
  readonly version: string;
  readonly installedAt: string;
  readonly installId: string | null;
  readonly archiveSha256: string | null;
  readonly platform: string | null;
  readonly arch: string | null;
};

/** Pending activation deferral (busy host). */
export type PendingActivation = {
  readonly toGeneration: string;
  readonly requestedAt: string;
  readonly cause: string;
};

/** Supported schema versions per durable file family. */
export const SUBSTRATE_SUPPORTED_VERSIONS: readonly number[] = [1];
export const TRANSITION_SUPPORTED_VERSIONS: readonly number[] = [1];
export const ACTIVATION_JOURNAL_SUPPORTED_VERSIONS: readonly number[] = [1];
export const INSTALL_SUPPORTED_VERSIONS: readonly number[] = [1];
export const PENDING_ACTIVATION_SUPPORTED_VERSIONS: readonly number[] = [1];
