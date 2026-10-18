import { homedir } from "node:os";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import {
  currentDataRootResolution,
  defaultDataRoot,
} from "@traycer/protocol/config/data-root";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

/**
 * The data folder this machine was moved to, or `null` while Traycer still
 * uses the default one. A damaged location record throws `DataRootError`
 * here as everywhere else: an unreadable record is never read as "not moved".
 */
export function movedDataRoot(): string | null {
  const resolution = currentDataRootResolution();
  if (resolution.kind !== "configured") return null;
  return resolution.root === defaultDataRoot(homedir())
    ? null
    : resolution.root;
}

/**
 * Refuses a registry host that is not at or above the installed one while the
 * data folder is moved.
 *
 * A host build older than relocation ignores `location.json`: installed over a
 * moved folder it starts on the retained old folder, writes its data there and
 * fails its health check. An installed version this cannot order (a `local-*`
 * build) is refused too, because nothing proves the registry target is not
 * such an older build. Call it at plan time, before any transfer, staging or
 * swap, and only where a registry target would replace an EXISTING install:
 * a fresh install, a `--from` archive and the same version re-installed are
 * not its business.
 */
export function refuseOlderHostWhileDataMoved(input: {
  readonly command: string;
  readonly environment: Environment;
  readonly installedVersion: string;
  readonly targetVersion: string;
}): void {
  if (input.installedVersion === input.targetVersion) return;
  const comparison = compareHostVersions(
    input.installedVersion,
    input.targetVersion,
  );
  if (comparison.comparable && comparison.ordering !== "greater") return;
  const root = movedDataRoot();
  if (root === null) return;
  throw cliError({
    code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
    message: `${input.command}: Traycer's data folder was moved to ${root}; installing a host that is not newer than the installed ${input.installedVersion} is not supported there. Nothing was transferred.`,
    details: {
      environment: input.environment,
      targetVersion: input.targetVersion,
      installedVersion: input.installedVersion,
    },
    exitCode: 1,
  });
}
