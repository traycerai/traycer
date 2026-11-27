import { lstat, readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Environment } from "../runner/environment";
import {
  CLI_ERROR_CODES,
  cliError,
  isErrnoException,
  type CliError,
} from "../runner/errors";
import { hostInstallDir } from "../store/paths";

export function windowsFreshInstallRequired(evidence: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message:
      "On Windows, --no-service-register needs an empty host slot. Run the ordinary host install without --no-service-register.",
    details: { evidence },
    exitCode: 1,
  });
}

export async function assertAbsentWindowsInstallTarget(
  environment: Environment,
): Promise<void> {
  const install = hostInstallDir(environment);
  const target = await lstat(install).catch((cause: unknown) => {
    if (isErrnoException(cause) && cause.code === "ENOENT") return null;
    throw windowsFreshInstallRequired("install-directory");
  });
  if (target !== null) throw windowsFreshInstallRequired("install-directory");

  const siblings = await readdir(dirname(install)).catch((cause: unknown) => {
    if (isErrnoException(cause) && cause.code === "ENOENT") return [];
    throw windowsFreshInstallRequired("install-aside");
  });
  const asidePrefix = `${basename(install).toLowerCase()}.old-`;
  if (siblings.some((name) => name.toLowerCase().startsWith(asidePrefix))) {
    throw windowsFreshInstallRequired("install-aside");
  }
}
