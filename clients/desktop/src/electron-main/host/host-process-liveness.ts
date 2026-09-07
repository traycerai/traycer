import { readPidMetadataState } from "./host-lifecycle";
import { getPublishedProcessIdentityVerdict } from "./process-identity";
import type { HostProcessLiveness } from "./host-recovery-governor";

export async function readPublishedHostProcessLiveness(
  pidMetadataFile: string,
): Promise<HostProcessLiveness> {
  const state = await readPidMetadataState(pidMetadataFile);
  // ENOENT only: a deliberate stop unlinked pid.json; a host that has not bound is invisible.
  if (state.kind === "absent") return "dead";
  // Any other read failure is unknown, not permission to restart.
  if (state.kind !== "parsed") return "alive";

  const verdict = await getPublishedProcessIdentityVerdict(
    state.snapshot.pid,
    state.startIdentity,
  );
  // Recycled pid (`mismatch`) is not this host.
  if (verdict === "dead" || verdict === "mismatch") return "dead";
  // `indeterminate` is alive: guessing dead would kill a working host.
  return "alive";
}
