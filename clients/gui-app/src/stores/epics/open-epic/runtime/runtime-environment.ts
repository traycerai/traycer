/**
 * The renderer's `RuntimeEnvironment` - the one place in the epic runtime that is allowed to know
 * `window` and `appLogger` exist.
 */
import type {
  RuntimeEnvironment,
  RuntimeLogFields,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import { appLogger } from "@/lib/logger";

/** The renderer environment. */
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
