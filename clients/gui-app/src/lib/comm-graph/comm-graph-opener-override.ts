import type { CommGraphSubscriptionOpener } from "@/lib/comm-graph/comm-graph-subscription";
import type { CommGraphCloudSubscriptionOpener } from "@/lib/comm-graph/comm-graph-cloud-subscription";

/**
 * Test / production seam for the comm-graph tile's per-host fan-in. Production
 * leaves this `null` and the tile opens real durable stream transports; tests
 * install a fake opener so the tile's merge, degrade, and rendering paths run
 * in jsdom against real stores with only the socket faked.
 */
let openerOverride: CommGraphSubscriptionOpener | null = null;
let cloudOpenerOverride: CommGraphCloudSubscriptionOpener | null = null;

export function __setCommGraphSubscriptionOpenerForTests(
  opener: CommGraphSubscriptionOpener | null,
): void {
  openerOverride = opener;
}

export function getCommGraphSubscriptionOpenerOverride(): CommGraphSubscriptionOpener | null {
  return openerOverride;
}

export function __setCommGraphCloudSubscriptionOpenerForTests(
  opener: CommGraphCloudSubscriptionOpener | null,
): void {
  cloudOpenerOverride = opener;
}

export function getCommGraphCloudSubscriptionOpenerOverride(): CommGraphCloudSubscriptionOpener | null {
  return cloudOpenerOverride;
}
