/** The runtime worker's entry module. Deliberately three lines. */
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
