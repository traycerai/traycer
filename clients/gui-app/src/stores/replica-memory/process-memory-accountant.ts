import type {
  MemoryAccountant,
  MonotonicSequence,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
  createMonotonicSequence,
} from "@traycer-clients/shared/replica-runtime";
import {
  CHAT_WINDOWS_SOFT_LIMIT_BYTES,
  DEFAULT_NEAR_THRESHOLD_RATIO,
  EPIC_REPLICAS_SOFT_LIMIT_BYTES,
  HOT_DOCS_SOFT_LIMIT_BYTES,
  OBSERVED_RENDERER_CEILING_BYTES,
} from "@/stores/replica-memory/budget-limits";
import {
  createChatWindowBudgetBook,
  type ChatWindowBudgetBook,
} from "@/stores/replica-memory/chat-window-budget";
import {
  createEpicReplicaBudgetBook,
  type EpicReplicaBudgetBook,
} from "@/stores/replica-memory/epic-replica-budget";
import {
  createHotDocBudgetBook,
  type HotDocBudgetBook,
} from "@/stores/replica-memory/hot-doc-budget";

/**
 * The process-wide memory runtime: one accountant, three plane books.
 *
 * Planes register here so a chat window, a hot artifact doc and an epic
 * replica all argue over the same snapshot. The books own WHAT to drop;
 * the accountant owns WHETHER to ask. Recency is one counter so LRU is
 * recency, not per-store publish count.
 */
export interface ProcessMemoryRuntime {
  readonly accountant: MemoryAccountant;
  readonly chatWindows: ChatWindowBudgetBook;
  readonly hotDocs: HotDocBudgetBook;
  readonly epicReplicas: EpicReplicaBudgetBook;
  readonly observedCeilingBytes: number;
  readonly recency: MonotonicSequence;
  nextRuntimeToken(): string;
  stampChatRecency(): number;
}

export function createProcessMemoryRuntime(
  environment: RuntimeEnvironment,
): ProcessMemoryRuntime {
  const chatWindows = createChatWindowBudgetBook();
  const hotDocs = createHotDocBudgetBook();
  const epicReplicas = createEpicReplicaBudgetBook();
  const recency = createMonotonicSequence();
  const runtimeTokens = createMonotonicSequence();
  const accountant = createMemoryAccountant({
    environment,
    observedCeilingBytes: OBSERVED_RENDERER_CEILING_BYTES,
  });

  accountant.register({
    planeId: BUDGET_PLANE_IDS.chatWindows,
    softLimitBytes: CHAT_WINDOWS_SOFT_LIMIT_BYTES,
    nearThresholdRatio: DEFAULT_NEAR_THRESHOLD_RATIO,
    evict: (overBytes) => chatWindows.evict(overBytes),
  });
  accountant.register({
    planeId: BUDGET_PLANE_IDS.hotDocs,
    softLimitBytes: HOT_DOCS_SOFT_LIMIT_BYTES,
    nearThresholdRatio: DEFAULT_NEAR_THRESHOLD_RATIO,
    evict: (overBytes) => hotDocs.evict(overBytes),
  });
  accountant.register({
    planeId: BUDGET_PLANE_IDS.epicReplicas,
    softLimitBytes: EPIC_REPLICAS_SOFT_LIMIT_BYTES,
    nearThresholdRatio: DEFAULT_NEAR_THRESHOLD_RATIO,
    evict: (overBytes) => epicReplicas.evict(overBytes),
  });

  return {
    accountant,
    chatWindows,
    hotDocs,
    epicReplicas,
    observedCeilingBytes: OBSERVED_RENDERER_CEILING_BYTES,
    recency,
    nextRuntimeToken(): string {
      return String(runtimeTokens.next());
    },
    stampChatRecency(): number {
      return recency.next();
    },
  };
}

let processRuntime: ProcessMemoryRuntime | null = null;

/**
 * The process-wide singleton. Callers inject the environment on first
 * construction so this module never touches `window`. Tests reset it
 * between files so one store's leftover session cannot walk another file's
 * `set()`.
 */
export function ensureProcessMemoryRuntime(
  environment: RuntimeEnvironment,
): ProcessMemoryRuntime {
  if (processRuntime === null) {
    processRuntime = createProcessMemoryRuntime(environment);
  }
  return processRuntime;
}

export function getProcessMemoryRuntime(): ProcessMemoryRuntime {
  if (processRuntime === null) {
    throw new Error(
      "process memory runtime is not installed; call ensureProcessMemoryRuntime",
    );
  }
  return processRuntime;
}

export function resetProcessMemoryRuntimeForTests(): void {
  processRuntime = null;
}

export function setProcessMemoryRuntimeForTests(
  runtime: ProcessMemoryRuntime,
): void {
  processRuntime = runtime;
}

export function getProcessMemoryAccountant(): MemoryAccountant {
  return getProcessMemoryRuntime().accountant;
}
