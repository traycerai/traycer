import type { SelectionAuthorityClient } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { selectionAuthorityLog } from "@/lib/host/authority-log";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { appLogger } from "@/lib/logger";

/**
 * This renderer's evidence kernel, keyed to the `SelectionAuthorityClient` instance (not a React effect).
 * A second kernel against an already-consumed attach-once client is terminal; retire the previous kernel when the client instance changes.
 */
let owned: {
  readonly client: SelectionAuthorityClient;
  readonly kernel: SelectionEvidenceKernel;
} | null = null;

/** Returns this renderer's kernel for `client`, constructing, binding and starting it on first use. */
export function acquireRendererSelectionKernel(
  client: SelectionAuthorityClient,
): SelectionEvidenceKernel {
  const existing = owned;
  if (existing !== null) {
    if (existing.client === client) return existing.kernel;
    // A different client means a different renderer host: the previous one's authority is unreachable from here for good, so its kernel is retired rather than left subscribed.
    // Only reachable in the browser/dev and test topologies; production builds exactly one client per load.
    existing.kernel.dispose();
    owned = null;
  }
  const kernel = new SelectionEvidenceKernel({
    client,
    now: () => Date.now(),
    log: selectionAuthorityLog,
  });
  // BIND BEFORE START.
  // The transports must be able to report from their very first dial: evidence produced before the attach begins is dropped by the buffering client, and an engine deriving from an evidence vacuum is the exact failure P1.1 refused to build.
  transportEvidenceRelay.bind(kernel);
  owned = { client, kernel };
  void kernel.start().then((result) => {
    if (result.ok) return;
    // Terminal for this generation by contract: the kernel has published its detached snapshot, which the bridge turns into an unbound directory.
    // Recovery is a fresh load or the next `reattachRequired`, never a retry here.
    appLogger.warn("[host-runtime] authority attach refused", {
      kind: result.kind,
    });
  });
  return kernel;
}
