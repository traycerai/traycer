import { homedir } from "node:os";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import {
  currentDataRootResolution,
  defaultDataRoot,
} from "@traycer/protocol/config/data-root";
import { isReleasedHostVersion } from "@traycer/protocol/host/store-formats";
import { configuredSupportedHostVersion } from "../host/supported-host-version";
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
 * Refuses, while the data folder is moved, a registry host that could be a
 * build older than relocation. Such a build ignores `location.json`: it starts
 * on `~/.traycer`, writes its data there and fails its health check, or sets
 * up a second installation there when nothing was installed.
 *
 * Two floors, both judged before any transfer, staging or swap:
 *
 *  - the installed build's version (`installedVersion`, from
 *    `installedFloorVersion`, `null` when nothing is installed): a
 *    target must be at or above it. One this cannot order (a `local-*` record
 *    with no runtime version) is refused, because nothing proves the target is
 *    not such an older build. The same version re-installed passes;
 *  - this CLI's stamped supported host (`configuredSupportedHostVersion`):
 *    the release pipeline stamps the exact host this CLI ships with, so a
 *    target below it may predate relocation - the registry's `latest` lags
 *    behind a new CLI until the host release is finalized. An unstamped (dev)
 *    build has no pin and so no floor.
 *
 * Call it only where a registry target would be installed: a `--from` archive
 * is not its business.
 *
 * Both messages carry `Traycer's data folder was moved to`, and the host's
 * `classifyBoundIntentRejection` reads that phrase with the error's code to
 * latch a parked `continue` this refuses. Change it there too, or the host
 * spawns the same refusal on every idle tick.
 */
export function refuseOlderHostWhileDataMoved(input: {
  readonly command: string;
  readonly environment: Environment;
  readonly installedVersion: string | null;
  readonly targetVersion: string;
}): void {
  const belowInstalled =
    input.installedVersion !== null &&
    input.installedVersion !== input.targetVersion &&
    !atOrAbove(input.targetVersion, input.installedVersion);
  const pin = configuredSupportedHostVersion();
  const belowPin = pin !== null && !atOrAbove(input.targetVersion, pin);
  if (!belowInstalled && !belowPin) return;
  // Read only once a floor fails, so an ordinary update never consults the
  // location record here.
  const root = movedDataRoot();
  if (root === null) return;
  const details = {
    environment: input.environment,
    targetVersion: input.targetVersion,
    installedVersion: input.installedVersion,
  };
  if (belowInstalled) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: `${input.command}: Traycer's data folder was moved to ${root}, so host ${input.targetVersion} cannot replace the installed ${input.installedVersion}. Nothing was transferred.`,
      details,
      exitCode: 1,
    });
  }
  throw cliError({
    code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
    message: `${input.command}: Traycer's data folder was moved to ${root}, so host ${input.targetVersion} cannot be installed there; this Traycer needs host ${pin} or newer. Nothing was transferred.`,
    details: { ...details, supportedHostVersion: pin },
    exitCode: 1,
  });
}

/**
 * `target` is orderable against `floor` and not below it. The source-tree
 * sentinel parses as SemVer and sorts below every release, but says nothing
 * about what wrote the data, so it orders nothing.
 */
function atOrAbove(target: string, floor: string): boolean {
  if (!isReleasedHostVersion(floor)) return false;
  const comparison = compareHostVersions(target, floor);
  return comparison.comparable && comparison.ordering !== "less";
}
