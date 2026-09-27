import {
  parkedActivationMatchesInstall,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { readHostInstallRecord } from "../manifest/host-install";
import type { Environment } from "../runner/environment";

/**
 * The one `stop-only` shape a generic restart may legally continue: a
 * `waiting-to-activate` PARK whose claim names exactly the bytes installed
 * now. Called under the same contender lock as the classification, so the
 * install record compared here is the one the action that follows acts on.
 *
 * Shared by `host restart` and `host free-port-and-restart`, which reach the
 * same stop-only branch from two entry points; one predicate keeps them
 * admitting the same parks.
 *
 * ## Why a park is different from the other stop-only records
 *
 * `recoveryActionFor` (shared contender) answers `stop-only` for three shapes,
 * and it is right about two of them: `applying` and `preparing/activate` are
 * ACTIVE, an executor may be one span away from its own restart edge, and a
 * generic relaunch could race it. A park has no holder by definition, and the
 * bytes it waits to activate are the installed ones - so when the installed
 * identity is the attempt's own, relaunching the installed host IS the
 * activation restart the park is waiting for. That is exactly the exemption
 * the supervisor's own relaunch already carries
 * (`supervisorRelaunchDisposition` in shared, added after the commands'
 * stop-only arms were written and never reconciled with them), and the host's
 * reconciler concludes the record once it is serving the target. The
 * predicate is the shared one, not a copy: every site must admit the same
 * parks.
 *
 * ## What the old behaviour did
 *
 * Every `host restart` under a park stopped the host, relaunched nothing,
 * exited 0 and reported `restarted:false` - a sentence nobody reads when the
 * caller is an agent or a script. On 2026-09-27 that took the staging host
 * down for an hour: the update that parked the record had been refused as
 * busy, a later restart "succeeded", launchd does not relaunch a deliberate
 * exit, and every service command then refused over the same record.
 *
 * `--defer-if-parked` is decided by the callers BEFORE they ask this: that
 * caller (Desktop's force-restart) runs its own activation once the command
 * reports `deferred`, so a matching park must still defer rather than be
 * activated behind its back.
 *
 * `false` for a `null` record, an active record, a claim-less park, a park
 * whose claim disagrees with the install record, and a missing install record:
 * unverifiable is refused, never admitted. The supervisor would refuse that
 * relaunch at spawn anyway, and a stop that says so beats a "restart" that
 * exits 0 having started nothing.
 */
export async function parkedActivationRelaunchable(
  environment: Environment,
  record: HostUpdateAttemptRecord | null,
): Promise<boolean> {
  if (record === null || record.execution !== "parked") return false;
  const installed = await readHostInstallRecord(environment);
  return parkedActivationMatchesInstall(
    record,
    installed === null
      ? null
      : {
          installedVersion: installed.version,
          // The RECORD, never a rebuilt literal - compared byte-for-byte with
          // the baseline `installGenerationOf` wrote at park time, exactly as
          // the supervisor's reader does (`commands/host-start.ts`).
          installGeneration: encodeInstallGeneration(installed),
        },
  );
}
