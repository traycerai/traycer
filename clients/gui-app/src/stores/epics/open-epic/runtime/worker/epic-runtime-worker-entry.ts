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
 * `self` rather than `globalThis`, and the DOM typing that used to be given as
 * the reason for the opposite choice is irrelevant: `resolveWorkerScopeTransport`
 * takes `unknown` and checks the shape at runtime, so what `lib: DOM` calls
 * `self` never reaches a type position here. `self` is simply the name of the
 * scope this module runs on. In a real dedicated worker the two are the same
 * object - `globalThis === self` is true there - so this is a naming
 * correction, not a behaviour change; the case where they DIVERGE is a scope
 * that is not a worker at all, and that is the guard's business, not this
 * line's.
 *
 * Nothing here imports the replica-runtime barrel. A worker entry that pulls
 * `replica-runtime/index.ts` drags the accountant, the session registry and
 * every seam behind them into the worker chunk; the deep imports below are
 * what keep this bundle to what it runs.
 */
import { resolveWorkerScopeTransport } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import { startEpicRuntimeWorkerHost } from "./epic-runtime-worker-host";
import {
  buildProxiedRuntimeFactories,
  installEpicRuntimeCore,
} from "./install-epic-runtime-core";

installEpicRuntimeCore(
  startEpicRuntimeWorkerHost(resolveWorkerScopeTransport(self)),
  buildProxiedRuntimeFactories,
);
