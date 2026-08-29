/**
 * A worker entry that boots the runtime host, for the one suite that runs
 * inside a real worker realm.
 *
 * This is NOT a copy of `epic-runtime-worker-entry.ts` kept for convenience -
 * it differs by exactly one call, and that call is why it exists.
 * `@vitest/web-worker` runs worker code against a `self` that is a plain
 * object whose prototype is the jsdom global: it carries `document` and lacks
 * `importScripts`, so `resolveWorkerScopeTransport` correctly refuses it, and
 * no suite can boot the shipped entry. The guard is right and the shim is not
 * a worker; both halves are pinned, just not by the same test:
 *
 * - the guard's two directions - `bridge-transports-scope-guard.test.ts`
 *   (`clients/shared`) and `worker-entry-main-thread-guard.test.ts`, the
 *   latter against a real jsdom window and the real entry module;
 * - everything the entry does AFTER the guard - this module, below.
 *
 * What is left uncovered by construction is the shipped entry's composition of
 * the two, which is one line. Do not "fix" that by loosening the guard.
 */
import {
  type BridgeMessageTargetLike,
  createMessageTargetTransport,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";

import { startEpicRuntimeWorkerHost } from "../epic-runtime-worker-host";

/**
 * The narrowing the shipped entry gets from `resolveWorkerScopeTransport`,
 * minus the worker-scope decision that the shim cannot satisfy. A predicate
 * rather than an assertion, for the same reason the real guard is one.
 */
function isMessageTargetLike(value: unknown): value is BridgeMessageTargetLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "postMessage") === "function" &&
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

// `self`, exactly as the shipped entry now reads it. Reverting this to
// `globalThis` is the ablation for `worker-boot-probe.test.ts`: under the shim
// the two are different objects, and `globalThis` is the page.
const scope: unknown = self;

if (!isMessageTargetLike(scope)) {
  throw new Error("boot-probe worker entry: scope is not a message target");
}

startEpicRuntimeWorkerHost(createMessageTargetTransport(scope));
