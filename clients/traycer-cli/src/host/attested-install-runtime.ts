import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { readHostInstallRecord } from "../manifest/host-install";
import type { Environment } from "../runner/environment";

/**
 * Install-record facts observed while the caller already owns `cli-lock`.
 * Service-only commands do not write install bytes, but they still need to
 * attest the exact record whose service they just started so Desktop never
 * derives a stamp generation from a stale pre-lock disk read.
 */
export interface AttestedInstallRuntime {
  readonly installGeneration: string | null;
  readonly runtimeVersion: string | null;
  readonly runtimeWasNull: boolean;
}

export async function attestInstallRuntime(
  environment: Environment,
): Promise<AttestedInstallRuntime> {
  const record = await readHostInstallRecord(environment);
  if (record === null) {
    return {
      installGeneration: null,
      runtimeVersion: null,
      runtimeWasNull: false,
    };
  }
  return {
    installGeneration: encodeInstallGeneration({
      installId: record.installId,
      installedAt: record.installedAt,
      archiveSha256: record.archiveSha256,
      version: record.version,
    }),
    runtimeVersion: record.runtimeVersion,
    runtimeWasNull: record.runtimeVersion === null,
  };
}
