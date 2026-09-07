import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { createCliLogger } from "../logger";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import { readLiveProcessStartTimeMs } from "../store/process-identity";
import { readHostPidMetadata } from "./pid-metadata";

// pid.json's `startedAt` is the time the host published readiness, not its OS process-creation time.
// On POSIX, `ps -o etime=` truncates elapsed time to whole seconds; reconstructing a wall-clock start from that value can land nearly 1s AFTER the real start.
export const PROCESS_START_PUBLICATION_ALLOWANCE_MS = 1_250;

// Deliberate residual, matching the ticket-1 break-lock availability trade: a PID recycled onto a process that starts within this allowance after the observed publication can be accepted and stamped.
// A zero allowance would routinely false-supersede fast genuine publishers because of `ps`'s truncation, stranding their records in activationUnknown.

// Guarded compare-and-set of the runtime stamp. Fail closed on an unreadable current value.
export interface StampRuntimeOptions {
  readonly environment: Environment;
  readonly expectedInstallGeneration: string;
  readonly observedPid: number;
  readonly observedStartedAt: string;
  readonly observedRuntimeVersion: string;
  /** Revalidated immediately before the durable runtime-stamp write. */
  readonly verifyMutationCapability: () => Promise<void>;
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

  // pid.json's timestamp marks publication/readiness and may be many seconds later than process creation, so it must NOT be passed through `verifyProcessIdentity`'s approximate-equality test.
  // A fresh process occupying a recycled PID necessarily began after this observed publication; a genuine publisher began at or before it.
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

  await opts.verifyMutationCapability();
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
