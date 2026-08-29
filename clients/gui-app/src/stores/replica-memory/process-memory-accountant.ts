import type {
  MemoryAccountant,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
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
 * the accountant owns WHETHER to ask.
 */
export interface ProcessMemoryRuntime {
  readonly accountant: MemoryAccountant;
  readonly chatWindows: ChatWindowBudgetBook;
  readonly hotDocs: HotDocBudgetBook;
  readonly epicReplicas: EpicReplicaBudgetBook;
  readonly observedCeilingBytes: number;
}

export function createProcessMemoryRuntime(
  environment: RuntimeEnvironment,
): ProcessMemoryRuntime {
  const chatWindows = createChatWindowBudgetBook();
  const hotDocs = createHotDocBudgetBook();
  const epicReplicas = createEpicReplicaBudgetBook();
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
  };
}

let processRuntime: ProcessMemoryRuntime | null = null;

/**
 * The renderer-wide singleton. Created on first read against the renderer
 * `RuntimeEnvironment`. Tests should call {@link createProcessMemoryRuntime}
 * with a fake environment rather than this.
 */
export function getProcessMemoryRuntime(): ProcessMemoryRuntime {
  if (processRuntime === null) {
    processRuntime = createProcessMemoryRuntime(
      createRendererRuntimeEnvironment(),
    );
  }
  return processRuntime;
}

export function getProcessMemoryAccountant(): MemoryAccountant {
  return getProcessMemoryRuntime().accountant;
}
