import type { CommGraphCloudSubscriptionOpener } from "@/lib/comm-graph/comm-graph-cloud-subscription";

/** Tests replace only the cloud transport; they use production authority rules. */
let cloudOpenerOverride: CommGraphCloudSubscriptionOpener | null = null;

export function __setCommGraphCloudSubscriptionOpenerForTests(
  opener: CommGraphCloudSubscriptionOpener | null,
): void {
  cloudOpenerOverride = opener;
}

export function getCommGraphCloudSubscriptionOpenerOverride(): CommGraphCloudSubscriptionOpener | null {
  return cloudOpenerOverride;
}
