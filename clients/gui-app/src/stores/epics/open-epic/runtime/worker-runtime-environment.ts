/**
 * The worker's `RuntimeEnvironment` - the other half of the boundary
 * `runtime-environment.ts` was written to be replaced at.
 *
 * Same interface, different platform. Three differences, and each is the
 * reason this file exists rather than a flag inside the renderer one:
 *
 *  - Timers are the BARE globals. `window.setTimeout` is what the renderer
 *    environment deliberately uses (jsdom and the suite's fake timers both
 *    patch the `window`-bound pair, and the artifact-room cooldown tests
 *    depend on that binding); in a worker there is no `window` at all, so the
 *    same line throws on import. Bare `setTimeout` is patched by
 *    `vi.useFakeTimers` on `globalThis`, so the fake-timer story survives.
 *  - The logger has nowhere local to write. `appLogger` is a renderer module
 *    reaching renderer transports, so a worker log line becomes a message the
 *    main thread re-emits into the real logger. That hop is why the sink is
 *    injected: this module must not know the bridge exists, and the bridge
 *    must not know what a logger is.
 *  - A caught value is reduced to a string HERE, before it crosses.
 *    `RuntimeLogger.error` takes `unknown`, which is what a `catch` binding
 *    is, and an arbitrary caught value is exactly what structured clone
 *    refuses - a `DOMException`, a class instance, anything holding a
 *    function. Reducing at the source means a logging call can never be the
 *    reason a message is lost, which is a bad way to lose one.
 */
import type {
  RuntimeEnvironment,
  RuntimeLogFields,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime/runtime-environment";
import type { RuntimeWorkerLogEntry } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

/**
 * Where a worker log line goes. Injected rather than imported so this module
 * stays a pure platform adapter, and so a suite can assert on the entries
 * without standing up a bridge.
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

/**
 * Reduces a caught value to one clonable line.
 *
 * The stack is kept when there is one: a worker error read on the main thread
 * with no stack points at the bridge rather than at the code that failed,
 * which is the wrong place to start every investigation.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack === undefined
      ? `${error.name}: ${error.message}`
      : error.stack;
  }
  if (typeof error === "string") return error;
  return `Non-error thrown: ${Object.prototype.toString.call(error)}`;
}
