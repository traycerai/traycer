import type { AttemptReadiness, ReadinessRung } from "../shared/host-process";
import type { TransitionGovernor } from "../durable/records";

/** The two durable macOS substrate changes. */
export type SubstrateTransitionKind = "fallback" | "reclaim";

/**
 * A phase is committed before the mutation it names.  Terminal phases retain
 * the governor delta in the same journal snapshot; they are not a second
 * mutable governor file.
 */
export type TransitionPhase =
  | "fallback-journaled"
  | "fallback-attesting-slot"
  | "fallback-provisioning"
  | "fallback-evicting-agent"
  | "fallback-committing"
  | "reclaim-probing"
  | "reclaim-awaiting-probe"
  | "reclaim-provisioning-agent"
  | "reclaim-committing-shutdown"
  | "reclaim-verifying-agent"
  | "reclaim-cleaning-fallback"
  | "reclaim-compensating-fallback"
  | "done"
  | "failed"
  | "compensated";

export type TransitionFailureClass =
  | "lwcr"
  | "probe-terminal"
  | "layer0-unavailable"
  | "readiness"
  | "stale-precondition"
  | "indeterminate"
  | "unknown";

export type LifecycleTransitionJournal = {
  readonly v: 1;
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly kind: SubstrateTransitionKind;
  readonly from: "smappservice" | "raw-fallback";
  readonly to: "smappservice" | "raw-fallback";
  readonly phase: TransitionPhase;
  /** Labels which are authorised to emit a probe marker for this journal. */
  readonly expectedIdentities: readonly string[];
  readonly compensation: "reprovision-fallback" | null;
  readonly startedAt: string;
  /**
   * Bound an ambiguous spawn-probe result.  It is set in the same write that
   * records `reclaim-awaiting-probe`, so a crash cannot turn marker absence
   * into an unbounded relaunch loop.
   */
  readonly probeDeadlineAt: string | null;
  /** Always present on writes made by the transition machinery. */
  readonly governor: TransitionGovernor;
  readonly terminal: {
    readonly outcome: "done" | "failed" | "compensated";
    readonly failureClass: TransitionFailureClass | null;
  } | null;
};

export type SubstrateSnapshot = {
  readonly v: 1;
  readonly active: "smappservice" | "raw-fallback";
  readonly since: string;
  readonly reason: string;
  readonly attestation: string | null;
};

export type RegistrationDurability = {
  /** A definition survives logout/login (plist, BTM, unit, or task). */
  readonly durable: boolean;
  /** The registration is currently loaded by its supervisor where applicable. */
  readonly loaded: boolean;
  readonly serviceLabel: string;
};

export type TransitionWorld = {
  readonly agent: RegistrationDurability;
  readonly fallback: RegistrationDurability;
  readonly readiness: AttemptReadiness;
  /** The active host has no work that would refuse a shutdown claim. */
  readonly idle: boolean;
};

export type TransitionJournalRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly journal: LifecycleTransitionJournal }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Persistence remains injected so this package never reaches into a platform
 * service controller.  The concrete CLI adapter uses write-temp + rename for
 * each call; the reconciler uses one journal write for every phase/governor
 * transition.
 */
export type TransitionJournalStore = {
  readJournal(): Promise<TransitionJournalRead>;
  writeJournal(journal: LifecycleTransitionJournal): Promise<void>;
  writeSubstrate(record: SubstrateSnapshot): Promise<void>;
  removeProbeMarker(transitionId: string): Promise<void>;
};

export type FallbackSlotAttestation =
  | { readonly kind: "attested"; readonly value: string }
  | { readonly kind: "rejected"; readonly reason: string };

export type ProbeLaunchResult =
  | { readonly kind: "started" }
  | { readonly kind: "failed"; readonly reason: string };

export type ReclaimShutdownResult =
  | { readonly kind: "committed" }
  | { readonly kind: "busy" }
  | { readonly kind: "stale" }
  | { readonly kind: "not-exited" };

/** Platform-specific mutations consumed by the shared reconciler. */
export type TransitionActuators = {
  attestFallbackSlot(): Promise<FallbackSlotAttestation>;
  provisionFallback(): Promise<void>;
  evictAgent(): Promise<void>;
  launchProbe(input: {
    readonly transitionId: string;
    readonly probeNonce: string;
    readonly serviceLabel: string;
  }): Promise<ProbeLaunchResult>;
  provisionAgent(): Promise<void>;
  commitRawShutdown(transitionId: string): Promise<ReclaimShutdownResult>;
  /** Must be invoked immediately after a successful raw shutdown commit. */
  kickstartAgent(): Promise<void>;
  removeFallback(): Promise<void>;
};

export type ReadinessObservation = {
  readonly attemptId: string;
  readonly highestRung: ReadinessRung;
  readonly readiness: AttemptReadiness;
};

export type TransitionResult =
  | { readonly kind: "done"; readonly journal: LifecycleTransitionJournal }
  | {
      readonly kind: "compensated";
      readonly journal: LifecycleTransitionJournal;
    }
  | {
      readonly kind: "deferred";
      readonly reason: "busy" | "indeterminate";
    }
  | {
      readonly kind: "deferred";
      readonly reason: "governor";
      readonly until: string;
    }
  | {
      readonly kind: "failed";
      readonly journal: LifecycleTransitionJournal;
    }
  | { readonly kind: "demoted"; readonly reason: string };
