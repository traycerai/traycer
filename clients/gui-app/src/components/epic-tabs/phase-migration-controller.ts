import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  notifyTabStructuralLocksChanged,
  registerTabCloseLockPredicate,
  registerTabStructuralLockPredicate,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

export type PhaseMigrationStatus = "pending" | "error" | "complete";

export interface PhaseMigrationSnapshot {
  readonly tabId: string;
  readonly phaseId: string;
  readonly status: PhaseMigrationStatus;
  readonly errorMessage: string | null;
}

export interface CompletedPhaseMigration {
  readonly tabId: string;
  readonly phaseId: string;
  readonly epicId: string;
}

interface PhaseMigrationRuntime extends PhaseMigrationSnapshot {
  readonly attemptId: number;
  readonly startedAttemptId: number | null;
  readonly start: PhaseMigrationStarter | null;
}

type PhaseMigrationListener = () => void;
type PhaseMigrationCompletionListener = (
  completion: CompletedPhaseMigration,
) => void;
type PhaseMigrationStarter = (attemptId: number) => void;

/**
 * Per-window runtime registry. It is intentionally independent of the slot
 * retention LRU: a renderer runner attaches to every open Phase-mode ref,
 * while the slot merely observes the exact runtime's progress or error state.
 */
export class PhaseMigrationController {
  private readonly runtimes = new Map<string, PhaseMigrationRuntime>();
  private readonly listeners = new Set<PhaseMigrationListener>();
  private readonly completionListeners =
    new Set<PhaseMigrationCompletionListener>();

  attach(
    tabId: string,
    phaseId: string,
    start: PhaseMigrationStarter,
  ): () => void {
    const previous = this.runtimes.get(tabId);
    if (previous === undefined) {
      this.runtimes.set(tabId, {
        tabId,
        phaseId,
        status: "pending",
        errorMessage: null,
        attemptId: 1,
        startedAttemptId: null,
        start,
      });
    } else if (previous.phaseId === phaseId) {
      this.runtimes.set(tabId, { ...previous, start });
    }
    this.startPending(tabId, phaseId);
    this.notify();
    return () => this.detach(tabId, phaseId, start);
  }

  snapshot(tabId: string): PhaseMigrationSnapshot | null {
    const runtime = this.runtimes.get(tabId);
    if (runtime === undefined) return null;
    return runtime;
  }

  subscribe(listener: PhaseMigrationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeCompletion(listener: PhaseMigrationCompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  retry(tabId: string): void {
    const runtime = this.runtimes.get(tabId);
    if (runtime === undefined || runtime.status !== "error") return;
    this.runtimes.set(tabId, {
      ...runtime,
      status: "pending",
      errorMessage: null,
      attemptId: runtime.attemptId + 1,
      startedAttemptId: null,
    });
    this.startPending(tabId, runtime.phaseId);
    this.notify();
  }

  succeed(
    tabId: string,
    phaseId: string,
    attemptId: number,
    epicId: string,
  ): void {
    const runtime = this.runtimes.get(tabId);
    if (
      runtime === undefined ||
      runtime.phaseId !== phaseId ||
      runtime.status !== "pending" ||
      runtime.attemptId !== attemptId
    ) {
      return;
    }
    const converted = tabCommandCoordinator.completePhaseMigration({
      tabId,
      phaseId,
      epicId,
    });
    if (!converted) {
      this.runtimes.set(tabId, {
        ...runtime,
        status: "error",
        errorMessage: "The migrated Epic could not be attached to this tab.",
      });
      this.notify();
      return;
    }
    this.runtimes.set(tabId, {
      ...runtime,
      status: "complete",
      errorMessage: null,
    });
    this.notify();
    const completion = { tabId, phaseId, epicId };
    this.completionListeners.forEach((listener) => listener(completion));
  }

  fail(
    tabId: string,
    phaseId: string,
    attemptId: number,
    message: string,
  ): void {
    const runtime = this.runtimes.get(tabId);
    if (
      runtime === undefined ||
      runtime.phaseId !== phaseId ||
      runtime.status !== "pending" ||
      runtime.attemptId !== attemptId
    ) {
      return;
    }
    this.runtimes.set(tabId, {
      ...runtime,
      status: "error",
      errorMessage: message,
    });
    this.notify();
  }

  isPhaseMigrationRef(ref: TabRef): boolean {
    if (ref.kind !== "epic") return false;
    return (
      useEpicCanvasStore.getState().tabsById[ref.id]?.surfaceMode?.kind ===
      "phase-migration"
    );
  }

  isPhaseMigrationCloseLocked(ref: TabRef): boolean {
    if (!this.isPhaseMigrationRef(ref)) return false;
    const runtime = this.runtimes.get(ref.id);
    return runtime === undefined || runtime.status === "pending";
  }

  resetForTesting(): void {
    this.runtimes.clear();
    this.notify();
  }

  private detach(
    tabId: string,
    phaseId: string,
    start: PhaseMigrationStarter,
  ): void {
    const runtime = this.runtimes.get(tabId);
    if (
      runtime === undefined ||
      runtime.phaseId !== phaseId ||
      runtime.start !== start
    ) {
      return;
    }
    if (runtime.status === "pending") {
      this.runtimes.set(tabId, { ...runtime, start: null });
    } else {
      this.runtimes.delete(tabId);
    }
    this.notify();
  }

  private startPending(tabId: string, phaseId: string): void {
    const runtime = this.runtimes.get(tabId);
    if (
      runtime === undefined ||
      runtime.phaseId !== phaseId ||
      runtime.status !== "pending" ||
      runtime.start === null ||
      runtime.startedAttemptId === runtime.attemptId
    ) {
      return;
    }
    this.runtimes.set(tabId, {
      ...runtime,
      startedAttemptId: runtime.attemptId,
    });
    runtime.start(runtime.attemptId);
  }

  private notify(): void {
    notifyTabStructuralLocksChanged();
    this.listeners.forEach((listener) => listener());
  }
}

export const phaseMigrationController = new PhaseMigrationController();

registerTabStructuralLockPredicate((ref) =>
  phaseMigrationController.isPhaseMigrationRef(ref),
);
registerTabCloseLockPredicate((ref) =>
  phaseMigrationController.isPhaseMigrationCloseLocked(ref),
);
