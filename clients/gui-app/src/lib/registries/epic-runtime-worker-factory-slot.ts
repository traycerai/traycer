/** The runtime-worker factory override slot, alone, with no value imports. */
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";

let runtimeWorkerFactoryOverride: (() => RuntimeWorkerLike) | null = null;

/** Test / production seam for the runtime WORKER. */
export function __setEpicRuntimeWorkerFactoryForTests(
  factory: (() => RuntimeWorkerLike) | null,
): void {
  runtimeWorkerFactoryOverride = factory;
}

/** The installed override, or `null` to use the production constructor. */
export function getEpicRuntimeWorkerFactoryOverride():
  | (() => RuntimeWorkerLike)
  | null {
  return runtimeWorkerFactoryOverride;
}
