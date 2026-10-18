import { admitClientProcess } from "@traycer-clients/shared/host-lock/data-migration-admission";
import { MigrationAdmissionError } from "@traycer/protocol/config/data-migration-admission";
import { homedir } from "node:os";
import {
  currentDataRootResolution,
  DataRootError,
  dataRootPlatformOf,
} from "@traycer/protocol/config/data-root";
import {
  describeDefaultDataRootFinding,
  inspectDefaultDataRoot,
} from "@traycer/protocol/config/data-root-default-check";
import { LOCAL_CLI_VERSION } from "./cli-version";

export type CliAdmission =
  | { readonly kind: "admitted" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Admit this CLI invocation against the data-migration startup barrier.
 * Called first in the entry, before the well-known slot refresh, the CLI log
 * or any command writes under the data root. Every invocation registers -
 * informational ones included - because nearly every command can write
 * (credentials refresh, config, logs) and a missed writer is a copy race.
 *
 * Registration does not wait for this process's start identity (a
 * PowerShell spawn on Windows); the entry is completed in the background and
 * an orderly exit removes it.
 */
/**
 * The startup warning for a populated default data folder beside the
 * configured one that is NOT a migration's retained backup (most likely an
 * older Traycer version booted it). Bounded identity check only
 * (`inspectDefaultDataRoot`); `traycer data status` has the full detail.
 * Never blocks and never changes either folder. Null when there is nothing
 * to say or the check cannot run.
 */
export function unexpectedDefaultDataRootWarning(): string | null {
  try {
    const finding = inspectDefaultDataRoot({
      homeDir: homedir(),
      platform: dataRootPlatformOf(process.platform),
      resolution: currentDataRootResolution(),
    });
    return finding.kind === "unexpected"
      ? describeDefaultDataRootFinding(finding)
      : null;
  } catch {
    return null;
  }
}

export async function admitCliInvocation(): Promise<CliAdmission> {
  try {
    const result = await admitClientProcess({
      component: "cli",
      build: LOCAL_CLI_VERSION,
      identityWaitMs: 0,
    });
    return result.kind === "admitted"
      ? { kind: "admitted" }
      : { kind: "refused", message: result.decision.message };
  } catch (error) {
    // An unusable location record refuses exactly as path derivation would,
    // with its own path-free message, and before anything is written.
    // A busy or unusable bootstrap folder refuses the same way: running
    // unadmitted would be the unchecked gap admission exists to close.
    if (error instanceof DataRootError) {
      return {
        kind: "refused",
        message: `${error.message} Run \`traycer data status\` for details.`,
      };
    }
    if (error instanceof MigrationAdmissionError) {
      return { kind: "refused", message: error.message };
    }
    throw error;
  }
}
