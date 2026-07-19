import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { createCliLogger } from "../logger";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { verifyProcessIdentity } from "../store/process-identity";
import { readHostPidMetadata } from "./pid-metadata";

// `host stamp-runtime` (hidden, internal) - the guarded compare-and-set
// that closes the `activationUnknown` debt (Host Update Layer Redesign
// Tech Plan, "Unknown runtime identity - two domains, never mixed" >
// "Unknown runtime identity - `activationUnknown` debt + one-time
// backfill"). The controller invokes this ONLY immediately after an
// activation cycle IT drove observes readiness of the fresh process,
// passing the install-generation fingerprint it ATTESTED from that
// cycle's own result (never a racy disk read - see `applyHost`'s
// `installGeneration`) plus the readiness identity it just observed
// (pid.json's own pid/startedAt/version).
//
// Stamps `runtimeVersion` only on a full match: the record's stamp is
// still null, its generation matches the expected fingerprint, and a
// FRESH re-read of pid.json still carries exactly the observed pid,
// startedAt, and version. Any mismatch is a structured `superseded`
// no-op - a terminal null-runtime bytes-only install (or an
// uninstall/reinstall) landing between the controller's readiness
// observation and this call must not inherit an unrelated process's
// stamp; its own debt survives for the next activation moment.
//
// Concurrency: like `applyHost`/`installHost`, this assumes the caller
// already holds the environment's `cli-lock` - see
// `commands/host-stamp-runtime.ts`.
export interface StampRuntimeOptions {
  readonly environment: Environment;
  readonly expectedInstallGeneration: string;
  readonly observedPid: number;
  readonly observedStartedAt: string;
  readonly observedRuntimeVersion: string;
}

export type StampRuntimeSupersededReason =
  | "no-install-record"
  | "runtime-already-stamped"
  | "generation-mismatch"
  | "no-live-host"
  | "pid-evidence-mismatch"
  | "pid-not-live";

export type StampRuntimeOutcome =
  | {
      readonly outcome: "stamped";
      readonly runtimeVersion: string;
      readonly installGeneration: string;
    }
  | {
      readonly outcome: "superseded";
      readonly reason: StampRuntimeSupersededReason;
    };

export async function stampRuntime(
  opts: StampRuntimeOptions,
): Promise<StampRuntimeOutcome> {
  const logger = createCliLogger(opts.environment);

  const installed = await readHostInstallRecord(opts.environment);
  if (installed === null) {
    logger.info("Host stamp-runtime superseded - no install record", {
      environment: opts.environment,
    });
    return { outcome: "superseded", reason: "no-install-record" };
  }
  if (installed.runtimeVersion !== null) {
    logger.info("Host stamp-runtime superseded - runtime already stamped", {
      environment: opts.environment,
      runtimeVersion: installed.runtimeVersion,
    });
    return { outcome: "superseded", reason: "runtime-already-stamped" };
  }

  const currentGeneration = encodeInstallGeneration({
    installId: installed.installId,
    installedAt: installed.installedAt,
    archiveSha256: installed.archiveSha256,
    version: installed.version,
  });
  if (currentGeneration !== opts.expectedInstallGeneration) {
    logger.info("Host stamp-runtime superseded - generation mismatch", {
      environment: opts.environment,
      expected: opts.expectedInstallGeneration,
      current: currentGeneration,
    });
    return { outcome: "superseded", reason: "generation-mismatch" };
  }

  const pidMetadata = await readHostPidMetadata(opts.environment);
  if (pidMetadata === null) {
    logger.info("Host stamp-runtime superseded - no live host", {
      environment: opts.environment,
    });
    return { outcome: "superseded", reason: "no-live-host" };
  }
  if (
    pidMetadata.pid !== opts.observedPid ||
    pidMetadata.startedAt !== opts.observedStartedAt ||
    pidMetadata.version !== opts.observedRuntimeVersion
  ) {
    logger.info("Host stamp-runtime superseded - pid evidence mismatch", {
      environment: opts.environment,
      observedPid: opts.observedPid,
      currentPid: pidMetadata.pid,
    });
    return { outcome: "superseded", reason: "pid-evidence-mismatch" };
  }

  // The static comparison above only proves pid.json still carries the
  // SAME recorded values the caller observed - it says nothing about
  // whether that process is still actually running. A crashed host that
  // never cleaned up pid.json would satisfy every check above and still
  // get its stale readiness observation stamped. Probe the OBSERVED pid's
  // live identity (liveness + a FRESH OS-level start-time read compared
  // against the observed startedAt, not pid.json's copy of it) and stamp
  // only on positive "alive-same" evidence - "dead", "alive-different"
  // (a recycled pid), and "indeterminate" (a probe failure) all fall back
  // to the same conservative `superseded`, never treated as license to
  // stamp.
  const observedStartedAtMs = Date.parse(opts.observedStartedAt);
  const identity = verifyProcessIdentity({
    pid: opts.observedPid,
    startedAtMs: Number.isNaN(observedStartedAtMs) ? null : observedStartedAtMs,
  });
  if (identity !== "alive-same") {
    logger.info("Host stamp-runtime superseded - pid not live", {
      environment: opts.environment,
      observedPid: opts.observedPid,
      identityVerdict: identity,
    });
    return { outcome: "superseded", reason: "pid-not-live" };
  }

  await writeHostInstallRecord(opts.environment, {
    ...installed,
    runtimeVersion: opts.observedRuntimeVersion,
  });
  logger.info("Host stamp-runtime stamped the null-runtime debt", {
    environment: opts.environment,
    runtimeVersion: opts.observedRuntimeVersion,
  });
  return {
    outcome: "stamped",
    runtimeVersion: opts.observedRuntimeVersion,
    installGeneration: currentGeneration,
  };
}
