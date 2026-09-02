/**
 * The runtime-worker factory override slot, alone, with no value imports.
 *
 * It lived in `epic-session-registry.ts` until gui-app's vitest setup file
 * needed to install a default. Importing the registry from a setup file loads
 * it for EVERY suite, ahead of any `vi.mock` — and the registry re-exports
 * `DEFAULT_MAX_LIVE_EPICS` from the `budget-limits` leaf, so
 * `budget-limits-binding.test.ts` (which mocks that leaf and asserts the
 * re-export tracks it) started reading the real 5 instead of its sentinel.
 *
 * This is the same defect as 4f's `StaleHostBindingAuthorityError`: a
 * leaf-shaped value declared inside a module with a graph, so importing the
 * value imports the graph. The fix is the same — give it its own address.
 *
 * **Keep this file free of value imports.** `RuntimeWorkerLike` below is a
 * type-only import and is erased; a value import here would put whatever it
 * names in front of every suite's mocks again, and the failure would surface
 * somewhere unrelated.
 */
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";

let runtimeWorkerFactoryOverride: (() => RuntimeWorkerLike) | null = null;

/**
 * Test / production seam for the runtime WORKER.
 *
 * jsdom has no `Worker`, so every suite that mounts a session needs a
 * constructor it can supply. gui-app's vitest setup file installs an
 * in-process one for all suites; the single opt-out is passing `null`, which
 * restores the production constructor — the only path that calls
 * `new Worker(new URL(...))`, a form Vite must see literally and jsdom cannot
 * execute.
 */
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
