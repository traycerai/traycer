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
/**
 * What an operator does next about a nonterminal record that a restart, a
 * status read or a refusal has just told them about. ONE writer for the three
 * sites, because the sentence has to be TRUE for the record it describes and
 * the shipped first version was not (traycer#2208 review): it told every
 * stop-only outcome "run `host update` to activate the update and bring it
 * back", and for a park whose install has since changed that command instead
 * ends the park `failed {install-changed}` before any restart
 * (`revalidateInstallIdentity`), exits 1, and leaves the host down.
 *
 * Three records, three sentences:
 *
 *  - ACTIVE (`applying`, `preparing/activate`, ...): an executor may be
 *    mid-flight outside the lock; wait, and `host update` recovers a dead one.
 *  - a park the install still matches, or a claim-less park (the resume
 *    compares nothing and proceeds): `host update` resumes it and, with no
 *    host running, starts one - that is the activation arm's `no-live-host`
 *    reading.
 *  - a park with a claim the install no longer matches: `host update` retires
 *    it and exits reporting the change; the host is then started by a command
 *    the (now terminal) record no longer refuses.
 *
 * `parkMatchesInstall` is the caller's `parkedActivationRelaunchable` answer,
 * passed in rather than re-read so the sentence describes the same install
 * the caller decided against. Ignored for a non-parked record.
 */
export function describeNonterminalRecordRecovery(
  record: HostUpdateAttemptRecord,
  parkMatchesInstall: boolean,
): string {
  if (record.execution !== "parked") {
    return `an update to host ${record.targetVersion} is in progress (${record.phase}); wait for it to finish, and if it was interrupted run 'traycer host update' to recover it and start the host`;
  }
  if (record.claim === undefined || parkMatchesInstall) {
    return `an update to host ${record.targetVersion} is parked at ${record.phase} with no updater running; run 'traycer host update' to resume it, which also starts the host if none is running`;
  }
  return `an update to host ${record.targetVersion} is parked at ${record.phase}, but the installed host no longer matches it, so nothing will relaunch it as-is; run 'traycer host update' to retire the stale record (it exits reporting the changed install), then 'traycer host ensure' to start the host`;
}

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
