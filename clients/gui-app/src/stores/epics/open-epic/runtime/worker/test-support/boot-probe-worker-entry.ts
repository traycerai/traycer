/**
 * A worker entry that boots the runtime host, for the one suite that runs inside a real worker
 * realm.
 */
import {
  type BridgeMessageTargetLike,
  createMessageTargetTransport,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";

import { startEpicRuntimeWorkerHost } from "../epic-runtime-worker-host";
import {
  buildProxiedRuntimeFactories,
  installEpicRuntimeCore,
} from "../install-epic-runtime-core";

/**
 * The narrowing the shipped entry gets from `resolveWorkerScopeTransport`, minus the worker-scope
 * decision that the shim cannot satisfy.
 */
function isMessageTargetLike(value: unknown): value is BridgeMessageTargetLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "postMessage") === "function" &&
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

// `self`, exactly as the shipped entry now reads it.
const scope: unknown = self;

if (!isMessageTargetLike(scope)) {
  throw new Error("boot-probe worker entry: scope is not a message target");
}

// Tracks the shipped entry per the rule above: it composes the core, so this does too.
installEpicRuntimeCore(
  startEpicRuntimeWorkerHost(createMessageTargetTransport(scope)),
  buildProxiedRuntimeFactories,
);
