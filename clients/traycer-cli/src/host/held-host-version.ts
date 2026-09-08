import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import {
  hostHeldVersionRecordPath,
  type HostHeldVersionRecord,
  type HostInstallRecord,
} from "@traycer/protocol/config/installation";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { Environment } from "../runner/environment";
import { ensureHostHomeDir } from "../store/paths";
import { createCliLogger } from "../logger";

// The CLI-owned "held host version" record (see the shared schema/reader in
// `@traycer/protocol/config/installation`). It names a host version the user
// DELIBERATELY chose - a `host update --allow-downgrade`, or a `host install
// --release X` / `host ensure --release X` below what was installed, whether
// typed in a terminal or driven by the desktop's rollback UI - and that no
// IMPLICIT convergence may move off:
//
//   - every liveness converge (`host ensure --keep-installed`, background AND
//     Doctor "converge-ready" alike) already keeps whatever is installed via
//     the `viability` policy - it never reinstalls a pin, so it never consults
//     this record (Doctor's "Install host" is the one EXPLICIT, version-
//     seeking converge, and like any explicit forward move it is not gated:
//     it simply leaves a new install whose id no longer matches); and
//   - the desktop's launch-time staged-apply stands down while the installed
//     host is the held instance. That decision is made in ONE place: `host
//     apply --respect-hold`, under the CLI mutation lock, keyed on the install
//     record as it is at that moment. The desktop never consults this record
//     itself - its launch apply always reaches the CLI (a desktop snapshot a
//     terminal downgrade could race must not be able to suppress the call);
//     when the CLI answers `no-op` the desktop discharges any activation debt
//     on a reachable held host, and starts a held host that is DOWN through
//     its ordinary failed-apply recovery (a keep-installed converge). The
//     hold is void for a held host the registry has since YANKED:
//     it protects a deliberate choice from client preference, never from
//     curation, and a yanked host is not viable (fail-open on a registry miss,
//     exactly like the `viability` yank check).
//
// WRITTEN ONLY AT A COMMITTED DOWNGRADE, and only under the same CLI mutation
// lock that wrote the install record, keyed on the ACTUAL committed vs previous
// versions (strict compare, so an equal-precedence lateral rebuild is not
// held). That single-writer-under-lock discipline is what makes it race free.
// It is removed in exactly ONE place - {@link resetHeldHostVersion} on
// uninstall, a full teardown - and NEVER on a version move:
//
//   - a FORWARD move (an update, an apply, a forward install) deactivates the
//     hold purely through the consulting gate, which fires only while
//     `held === installed`; once the install moves forward, `held !==
//     installed` and the record is inert. No delete on a move, so no
//     clear/ABA/TOCTOU race where a forward move races a concurrent downgrade
//     and removes the fresh hold that downgrade just set;
//   - a later downgrade OVERWRITES the record with its own target.
//
// So the gate (`held.installId === installedRecord.installId`) fires exactly
// when the current install IS the specific instance that was the deliberate
// downgrade - a stale record (after a forward move, or any later reinstall) is
// inert because that new install has a different id, and the next downgrade
// overwrites the record for its own instance. The stage keeps downloading
// throughout, so an explicit update is still a fast restart: the hold gates
// the APPLY, never the DOWNLOAD, and an explicit forward apply is never gated
// (it is not an implicit path), so it always wins and then leaves
// `installedRecord.installId !== held.installId`. The uninstall reset
// ({@link resetHeldHostVersion}) is tidiness on top of that binding, not the
// guarantee.
//
// The READ side is the shared, tolerant `readHostHeldVersion` in
// `@traycer/protocol/config/installation` (missing OR malformed => "nothing
// held"), symmetric with the install/staged readers; the desktop has its own
// on-disk mirror-reader.

function scratchSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/**
 * Record `version` as the held host version, replacing any prior hold. Atomic
 * (write a private sibling, then `rename` over the live path) so a concurrent
 * reader never observes a torn file - the same temp+rename discipline the
 * update-progress marker uses. The ONLY writer of this record.
 */
export async function setHeldHostVersion(
  environment: Environment,
  version: string,
  installId: string,
): Promise<void> {
  const logger = createCliLogger(environment);
  await ensureHostHomeDir(environment);
  const target = hostHeldVersionRecordPath(environment);
  const tmp = `${target}.tmp-${scratchSuffix()}`;
  const record: HostHeldVersionRecord = { version, installId };
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  logger.info("Held host version set", { environment, version, installId });
}

/**
 * Remove the hold entirely - the RESET path, called when the host is being
 * uninstalled. `installId` binding is what actually PREVENTS a stale hold from
 * being inherited by a later fresh install (its new install gets a fresh id
 * that no longer matches the record), so this reset is tidiness /
 * defence-in-depth, not the correctness mechanism: it stops a dangling sidecar
 * outliving the host it referred to. Unconditional because uninstall is a full
 * teardown, not a version move; the only delete of the record. Best-effort;
 * never throws.
 */
export async function resetHeldHostVersion(
  environment: Environment,
): Promise<void> {
  const logger = createCliLogger(environment);
  try {
    await rm(hostHeldVersionRecordPath(environment), { force: true });
  } catch (error) {
    logger.warn("Held host version reset failed", {
      environment,
      error: String(error),
    });
  }
}

/**
 * Hold the just-committed install (`committedVersion` at `committedInstallId`)
 * IFF it stepped strictly DOWN from `previousVersion` - a deliberate downgrade.
 * A forward, equal, incomparable, or first install (no previous) writes
 * nothing; the gate handles those by leaving `held.installId !== installed`.
 * The hold is bound to `committedInstallId` (the per-install UUID from the
 * record this commit just wrote), so a later reinstall of the same version
 * cannot inherit it.
 *
 * MUST be called at the committed-install boundary UNDER the same mutation lock
 * that wrote the install record, keyed on the ACTUAL committed/previous install
 * records (never a display projection that reports the previous *running*
 * version) so the predecessor is the one this swap actually replaced, not a
 * pre-lock sample a concurrent CLI could have changed. Best-effort at the call
 * site: a marker-write failure must never fail an install/update that already
 * committed. A `null` `committedInstallId` (a legacy record) cannot be bound to
 * an instance and so is deliberately not held.
 */
export async function holdVersionIfDowngrade(
  environment: Environment,
  previousVersion: string | null,
  committedVersion: string,
  committedInstallId: string | null,
): Promise<void> {
  if (previousVersion === null || committedInstallId === null) return;
  const comparison = compareHostVersions(committedVersion, previousVersion);
  if (comparison.comparable && comparison.ordering === "less") {
    await setHeldHostVersion(environment, committedVersion, committedInstallId);
  }
}

/**
 * The swap-commit observer every downgrade-capable install passes to the
 * committer (`CommitInstallFromSourceOptions.onSwapCommitted`). It records the
 * hold at the TRUE successful-swap boundary - under the mutation lock, the
 * instant the swap-in rename has placed the new tree, BEFORE the swap's own
 * post-rename carryover/invalidation (which can reject on authority loss with
 * the new install already in place) and BEFORE the post-swap lifecycle
 * bookkeeping hook (which may reject with the bytes nevertheless committed and
 * the host restarting - the T6 contract). Writing there rather than after the
 * committer RETURNS is what keeps such a committed downgrade from losing its
 * hold. Keyed on the record the swap just wrote, so the strict-downgrade
 * decision and the `installId` binding both use the actual committed instance.
 */
export function holdVersionOnSwapCommitted(
  environment: Environment,
): (info: {
  readonly record: HostInstallRecord;
  readonly previous: HostInstallRecord | null;
}) => Promise<void> {
  return ({ record, previous }) =>
    holdVersionIfDowngrade(
      environment,
      previous?.version ?? null,
      record.version,
      record.installId,
    );
}
