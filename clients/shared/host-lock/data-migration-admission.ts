import { homedir } from "node:os";
import {
  admitProcess,
  composeIncarnationVerdict,
  type AdmissionResult,
  type ProcessIncarnationProbe,
} from "@traycer/protocol/config/data-migration-admission";
import {
  currentComponentHandshake,
  type MigrationComponent,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  currentDataRootResolution,
  dataRootPlatformOf,
} from "@traycer/protocol/config/data-root";
import { probeProcessLivenessAsync } from "@traycer/protocol/config/process-liveness";
import {
  observeProcessStartAsync,
  ownProcessStartIdentityAsync,
  verifyProcessIdentityAsync,
} from "./process-identity";

/**
 * The CLI's and Desktop's process reads for data-migration admission: the
 * same liveness and identity reads their locks already use, so "is that the
 * same process" means one thing on this side, composed by the protocol's
 * incarnation rule, the twin of the host's probe. This process's own pid
 * keeps the locks' own-identity check.
 */
export const clientProcessIncarnationProbe: ProcessIncarnationProbe = {
  ownStartIdentity: ownProcessStartIdentityAsync,
  liveness: probeProcessLivenessAsync,
  verdict: (pid, recorded) =>
    pid === process.pid
      ? verifyProcessIdentityAsync({
          pid,
          startedAtMs: null,
          startIdentity: recorded,
        })
      : composeIncarnationVerdict({
          pid,
          recorded,
          liveness: probeProcessLivenessAsync,
          observe: observeProcessStartAsync,
        }),
};

// Long enough to outwait a busy admission (a few small file operations), short
// enough that a wedged one surfaces as "try again" rather than a hang.
const CLIENT_ADMISSION_MUTEX_WAIT_MS = 10_000;

/**
 * Admit this CLI or Desktop process against the data-migration barrier,
 * before it writes anything under the data root. Resolves the data root
 * first (throwing `DataRootError` exactly as path derivation would).
 */
export function admitClientProcess(input: {
  readonly component: Extract<MigrationComponent, "cli" | "desktop">;
  readonly build: string;
  readonly identityWaitMs: number;
}): Promise<AdmissionResult> {
  return admitProcess({
    homeDir: homedir(),
    platform: dataRootPlatformOf(process.platform),
    processResolution: currentDataRootResolution(),
    handshake: currentComponentHandshake(input.component, input.build),
    probe: clientProcessIncarnationProbe,
    mutexWaitMs: CLIENT_ADMISSION_MUTEX_WAIT_MS,
    identityWaitMs: input.identityWaitMs,
  });
}
