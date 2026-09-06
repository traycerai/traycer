/**
 * The renderer's `RuntimeEnvironment` — the one place in the epic runtime that
 * is allowed to know `window` and `appLogger` exist.
 *
 * Everything below this file reaches for timers, microtasks, the clock and the
 * log through the injected environment, never through a global. That is not
 * testing hygiene: the runtime is scheduled to move into a dedicated Web Worker
 * per renderer window, where `window` and the GUI's `appLogger` do not exist,
 * and a `window.setTimeout` compiles today and throws the moment a worker entry
 * imports it — surfacing as a blank pane rather than as a build error. This
 * module is the piece that gets REPLACED at that boundary; nothing else has to.
 */
import type {
  RuntimeEnvironment,
  RuntimeLogFields,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import { appLogger } from "@/lib/logger";

/**
 * The renderer environment.
 *
 * `window.setTimeout` rather than the bare global on purpose: jsdom and the
 * suite's fake timers both patch the `window`-bound pair, and the existing
 * artifact-room cooldown tests depend on that binding.
 */
export function createRendererRuntimeEnvironment(): RuntimeEnvironment {
  return {
    clock: {
      now(): number {
        return Date.now();
      },
    },
    scheduler: {
      schedule(delayMs: number, callback: () => void): RuntimeTimer {
        const id = window.setTimeout(callback, delayMs);
        return {
          cancel(): void {
            window.clearTimeout(id);
          },
        };
      },
      scheduleMicrotask(callback: () => void): void {
        queueMicrotask(callback);
      },
    },
    logger: {
      debug(message: string, fields: RuntimeLogFields): void {
        appLogger.debug(message, fields);
      },
      warn(message: string, fields: RuntimeLogFields): void {
        appLogger.warn(message, fields);
      },
      error(message: string, fields: RuntimeLogFields, error: unknown): void {
        appLogger.error(message, fields, error);
      },
    },
  };
}
