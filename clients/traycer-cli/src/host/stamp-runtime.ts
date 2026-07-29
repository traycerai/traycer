import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { createCliLogger } from "../logger";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { readLiveProcessStartTimeMs } from "../store/process-identity";
import { readHostPidMetadata } from "./pid-metadata";

// pid.json's `startedAt` is the time the host published readiness, not its OS
// process-creation time. On POSIX, `ps -o etime=` truncates elapsed time to
// whole seconds; reconstructing a wall-clock start from that value can land
// nearly 1s AFTER the real start. Keep a 250ms scheduling/read margin beyond
// that known resolution limit.
export const PROCESS_START_PUBLICATION_ALLOWANCE_MS = 1_250;

// Deliberate residual, matching the ticket-1 break-lock availability trade:
// a PID recycled onto a process that starts within this allowance after the
// observed publication can be accepted and stamped. A zero allowance would
// routinely false-supersede fast genuine publishers because of `ps`'s
// truncation, stranding their records in activationUnknown. Closing the rare
// false-accept requires a process-asserted instance token in pid.json, which
// is a traycer-host format change and deliberately out of scope here.

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
  | "runtime-version-mismatch"
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
  if (installed.runtimeVersion !== null) {
    if (installed.runtimeVersion !== opts.observedRuntimeVersion) {
      logger.info("Host stamp-runtime superseded - runtime version mismatch", {
        environment: opts.environment,
        stampedRuntimeVersion: installed.runtimeVersion,
        observedRuntimeVersion: opts.observedRuntimeVersion,
      });
      return { outcome: "superseded", reason: "runtime-version-mismatch" };
    }
    logger.info("Host stamp-runtime superseded - runtime already stamped", {
      environment: opts.environment,
      runtimeVersion: installed.runtimeVersion,
    });
    return { outcome: "superseded", reason: "runtime-already-stamped" };
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

  // pid.json's timestamp marks publication/readiness and may be many seconds
  // later than process creation, so it must NOT be passed through
  // `verifyProcessIdentity`'s approximate-equality test. A fresh process
  // occupying a recycled PID necessarily began after this observed
  // publication; a genuine publisher began at or before it.
  const publishedAtMs = Date.parse(opts.observedStartedAt);
  const processStartedAtMs = readLiveProcessStartTimeMs(opts.observedPid);
  if (
    Number.isNaN(publishedAtMs) ||
    processStartedAtMs === null ||
    processStartedAtMs > publishedAtMs + PROCESS_START_PUBLICATION_ALLOWANCE_MS
  ) {
    logger.info("Host stamp-runtime superseded - pid not live", {
      environment: opts.environment,
      observedPid: opts.observedPid,
      publishedAt: opts.observedStartedAt,
      processStartedAtMs,
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
