/**
 * The runtime worker's entry module.
 *
 * Deliberately three lines. Everything this file could contain is in
 * `epic-runtime-worker-host.ts` instead, because an entry module runs on
 * import and can only be exercised by actually starting a worker - which no
 * suite in this package can do (jsdom has no `Worker`) and no type-check can
 * either. What is left here is the one thing that genuinely cannot be tested
 * without a worker: reaching the ambient scope.
 *
 * `globalThis` rather than `self`: this package compiles with `lib: DOM`,
 * where `self` is typed as a `Window` whose `postMessage` signature is the
 * three-argument one. `resolveWorkerScopeTransport` checks the shape it
 * actually needs and throws a legible error if this module is ever imported
 * on the main thread, which is otherwise a runtime that posts into the window
 * and answers nothing.
 *
 * Nothing here imports the replica-runtime barrel. A worker entry that pulls
 * `replica-runtime/index.ts` drags the accountant, the session registry and
 * every seam behind them into the worker chunk; the deep imports below are
 * what keep this bundle to what it runs.
 */
import { resolveWorkerScopeTransport } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import { startEpicRuntimeWorkerHost } from "./epic-runtime-worker-host";

startEpicRuntimeWorkerHost(resolveWorkerScopeTransport(globalThis));
