/**
 * The worker's `RuntimeEnvironment` - the other half of the boundary `runtime-environment.ts` was
 * written to be replaced at. Same interface, different platform.
 */
import type {
  RuntimeEnvironment,
  RuntimeLogFields,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime/runtime-environment";
import type { RuntimeWorkerLogEntry } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

/**
 * Where a worker log line goes. Injected rather than imported so this module stays a pure platform
 * adapter, and so a suite can assert on the entries without standing up a bridge.
 */
export type WorkerLogSink = (entry: RuntimeWorkerLogEntry) => void;

export function createWorkerRuntimeEnvironment(
  emit: WorkerLogSink,
): RuntimeEnvironment {
  return {
    clock: {
      now(): number {
        return Date.now();
      },
    },
    scheduler: {
      schedule(delayMs: number, callback: () => void): RuntimeTimer {
        const id = setTimeout(callback, delayMs);
        return {
          cancel(): void {
            clearTimeout(id);
          },
        };
      },
      scheduleMicrotask(callback: () => void): void {
        queueMicrotask(callback);
      },
    },
    logger: {
      debug(message: string, fields: RuntimeLogFields): void {
        emit({ level: "debug", message, fields, error: null });
      },
      warn(message: string, fields: RuntimeLogFields): void {
        emit({ level: "warn", message, fields, error: null });
      },
      error(message: string, fields: RuntimeLogFields, error: unknown): void {
        emit({ level: "error", message, fields, error: describeError(error) });
      },
    },
  };
}

/** Reduces a caught value to one clonable line. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack === undefined
      ? `${error.name}: ${error.message}`
      : error.stack;
  }
  if (typeof error === "string") return error;
  return `Non-error thrown: ${Object.prototype.toString.call(error)}`;
}
