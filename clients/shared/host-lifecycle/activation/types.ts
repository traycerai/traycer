import type { TransitionGovernor } from "../durable/records";
import type { MutationResult } from "../actuators/conditional-mutation";
import type { AttemptReadiness } from "../shared/host-process";

/**
 * Code-level transcription of the cutover plan's phase × disk-shape table.
 * This is the only runtime phase list; every non-terminal phase names the
 * NEXT mutation and is durable before it runs.
 */
export const ACTIVATION_PHASES = [
  "claiming-stop",
  "committing-stop",
  "renaming-install-aside",
  "renaming-staged-install",
  "verifying",
  "invalidating-aside",
  "rollback-renaming-install-aside",
  "rollback-restoring-aside",
  "done",
  "failed",
] as const;

export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];

export function isActivationPhase(value: unknown): value is ActivationPhase {
  return ACTIVATION_PHASES.some((phase) => phase === value);
}

export type ActivationFailureClass =
  "readiness" | "stale-precondition" | "indeterminate" | "unknown";

/**
 * Relative generations make the accepted disk states mechanically checkable
 * without coupling this pure package to the installer record implementation.
 */
export type ActivationDiskState = {
  readonly install: "from" | "to" | "absent";
  readonly staged: "to" | "absent";
  /** `multiple` is a bounded-storage violation and no recovery mutates it. */
  readonly aside: "from" | "absent" | "multiple";
};

export type ActivationAttempt = {
  readonly state: "installed-not-ready";
  readonly attemptId: string;
};

export type LifecycleActivationJournal = {
  readonly v: 1;
  readonly fromGeneration: string;
  readonly toGeneration: string;
  readonly phase: ActivationPhase;
  /**
   * The host-issued shutdown authority that crosses the write-ahead boundary
   * between `claiming-stop` and `committing-stop`. It is cleared immediately
   * after commit, rollback, or terminal failure.
   */
  readonly stopClaimToken: string | null;
  /**
   * Non-null only during `verifying`; this is the persisted proof that the
   * new install is present but has not yet satisfied attempt-scoped readiness.
   */
  readonly attempt: ActivationAttempt | null;
  /** Set before entering a rollback phase so its terminal write is total. */
  readonly rollbackFailure: ActivationFailureClass | null;
  /** Always present so terminal outcome and governor delta share one write. */
  readonly governor: TransitionGovernor;
  readonly terminal: {
    readonly outcome: "done" | "failed";
    readonly failureClass: ActivationFailureClass | null;
    /** The non-terminal phase that produced an honest failed outcome. */
    readonly failurePhase: ActivationPhase | null;
  } | null;
};

export type ActivationJournalRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly journal: LifecycleActivationJournal }
  | { readonly kind: "invalid"; readonly reason: string };

export type ActivationJournalStore = {
  readJournal(): Promise<ActivationJournalRead>;
  writeJournal(journal: LifecycleActivationJournal): Promise<void>;
  writePendingActivation(input: {
    readonly toGeneration: string;
    readonly requestedAt: string;
    readonly cause: string;
  }): Promise<void>;
  clearPendingActivation(): Promise<void>;
};

export type StopClaimResult =
  | { readonly kind: "claimed"; readonly token: string }
  | { readonly kind: "busy" }
  | { readonly kind: "stale-precondition" };

export type StopCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "busy" }
  | { readonly kind: "stale-precondition" };

/**
 * The machine owns sequencing; platform/CLI adapters own concrete process and
 * filesystem operations.  Renames are deliberately split to mirror the real
 * atomicSwap implementation's install-absent window.
 */
export type ActivationActuators = {
  claimStop(): Promise<StopClaimResult>;
  commitStop(token: string): Promise<StopCommitResult>;
  probeDisk(): Promise<ActivationDiskState>;
  /** T5's conditional actuator result; locked Windows binaries are stale. */
  renameInstallAside(): Promise<MutationResult>;
  /** T5's conditional actuator result; locked Windows binaries are stale. */
  renameStagedInstall(): Promise<MutationResult>;
  startAttempt(attemptId: string): Promise<MutationResult>;
  observeAttempt(attemptId: string): Promise<AttemptReadiness>;
  invalidateAside(): Promise<MutationResult>;
  /** Reverse rename one: `install/` (new) becomes `staged/` (new). */
  renameInstalledToStaged(): Promise<MutationResult>;
  /** Reverse rename two: retained old aside becomes canonical `install/`. */
  restoreAside(): Promise<MutationResult>;
};

export type ActivationResult =
  | { readonly kind: "done"; readonly journal: LifecycleActivationJournal }
  | { readonly kind: "failed"; readonly journal: LifecycleActivationJournal }
  | {
      readonly kind: "deferred";
      readonly reason: "busy" | "indeterminate" | "stale-precondition";
    }
  | {
      readonly kind: "deferred";
      readonly reason: "governor";
      readonly until: string;
    }
  | { readonly kind: "demoted"; readonly reason: string };
