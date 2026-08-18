import type { SelectionAuthorityClient } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { selectionAuthorityLog } from "@/lib/host/authority-log";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { appLogger } from "@/lib/logger";

/**
 * This renderer's evidence kernel, owned at the RENDERER's lifetime rather
 * than at a React effect's (redesign P1.3, review finding F2).
 *
 * ## Why the effect could not own it
 *
 * `SelectionAuthorityClient` is attach-once per INSTANCE: the buffering client
 * sets `attachStarted` on the first `attach()` and answers `superseded`
 * forever after, because a consumed generation is exactly what that arm
 * describes. And the client is built ONCE per renderer load - the preload
 * bridge constructs it at bridge-construction time, well above React.
 *
 * The kernel used to be constructed inside `HostRuntimeProvider`'s runtime
 * effect and disposed in its cleanup. Under StrictMode's deliberate
 * setup -> cleanup -> setup, that means a SECOND kernel attaching against the
 * SAME already-consumed client: `superseded`, terminal by contract, and the
 * window spends the rest of its life with a detached kernel - no leases, no
 * effective host, and every transport reporting into a relay bound to a kernel
 * that was disposed a tick earlier. Nothing about that is dev-only in
 * principle; StrictMode is just the thing that makes it happen every launch.
 *
 * The two lifetimes have to match, and it is the CLIENT's that is real. So the
 * kernel is keyed to the client instance and outlives every effect that reads
 * it. `mountSelectionAuthorityBridge` already anticipated this construction -
 * its subscribe-time `apply(kernel.snapshot())` was documented as provably
 * unreachable only "while the bridge owned construction", and becomes the line
 * that delivers the opening binding once the kernel is handed over
 * already-attached. That is now the ordinary case, not the exotic one.
 *
 * ## What "released" means here
 *
 * Nothing outlives a renderer load, so there is no unload step to write: the
 * page going away takes the client, the kernel and this module with it. The
 * one real transition is a DIFFERENT client arriving - a second runner host in
 * one process, which is the browser/dev and test topology - and that is
 * handled below by retiring the previous kernel before the new one binds. The
 * relay replaces its target outright rather than stacking (see
 * `TransportEvidenceRelay.bind`), so two live kernels for one window remains a
 * state this design does not have.
 */
let owned: {
  readonly client: SelectionAuthorityClient;
  readonly kernel: SelectionEvidenceKernel;
} | null = null;

/**
 * Returns this renderer's kernel for `client`, constructing, binding and
 * starting it on first use.
 *
 * Idempotent for a given client, which is the whole point: a caller that runs
 * twice - a StrictMode double-invoke, a remount, an effect re-running because
 * an unrelated dependency changed - gets the SAME started kernel back and must
 * not dispose it. Callers own their subscription to the kernel, never the
 * kernel.
 */
export function acquireRendererSelectionKernel(
  client: SelectionAuthorityClient,
): SelectionEvidenceKernel {
  const existing = owned;
  if (existing !== null) {
    if (existing.client === client) return existing.kernel;
    // A different client means a different renderer host: the previous one's
    // authority is unreachable from here for good, so its kernel is retired
    // rather than left subscribed. Only reachable in the browser/dev and test
    // topologies; production builds exactly one client per load.
    existing.kernel.dispose();
    owned = null;
  }
  const kernel = new SelectionEvidenceKernel({
    client,
    now: () => Date.now(),
    log: selectionAuthorityLog,
  });
  // BIND BEFORE START. The transports must be able to report from their very
  // first dial: evidence produced before the attach begins is dropped by the
  // buffering client, and an engine deriving from an evidence vacuum is the
  // exact failure P1.1 refused to build.
  transportEvidenceRelay.bind(kernel);
  owned = { client, kernel };
  void kernel.start().then((result) => {
    if (result.ok) return;
    // Terminal for this generation by contract: the kernel has published its
    // detached snapshot, which the bridge turns into an unbound directory.
    // Recovery is a fresh load or the next `reattachRequired`, never a retry
    // here.
    appLogger.warn("[host-runtime] authority attach refused", {
      kind: result.kind,
    });
  });
  return kernel;
}
