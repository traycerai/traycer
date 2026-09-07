/**
 * The main side's answers to the worker->main calls, for suites whose subject is something else.
 * Both defaults fail closed, and each in the vocabulary its own caller acts on.
 */
import type { MainCallHandlers } from "../bridge-endpoint";

export function stubMainCallHandlers(
  overrides: Partial<MainCallHandlers>,
): MainCallHandlers {
  const base: MainCallHandlers = {
    "main/write-command": () =>
      Promise.resolve({
        ok: false,
        failure: {
          kind: "queued",
          reason: "no write transport in this fixture",
          boundedRetry: false,
          retryAfterMs: null,
        },
      }),
    "main/lane-unary": () =>
      Promise.resolve({
        ok: false,
        reason: "no lane unary transport in this fixture",
      }),
  };
  return { ...base, ...overrides };
}
