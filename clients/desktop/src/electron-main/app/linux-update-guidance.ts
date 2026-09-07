import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isWsl } from "./wsl";
import type { DesktopAppUpdateGuidance } from "../../ipc-contracts/app-update-types";

const execFileAsync = promisify(execFile);

export type LinuxPackageType = "deb" | "rpm";

const DESKTOP_RELEASES_URL = "https://github.com/traycerai/traycer/releases";

const REGISTRATION_QUERY_TIMEOUT_MS = 5_000;

/** `package-type` is written by app-builder-lib's `FpmTarget` only for deb/rpm (and pacman, which we don't currently ship - see `build.linux.target` in `package.json`). */
export function readLinuxPackageType(): LinuxPackageType | null {
  const path = join(process.resourcesPath, "package-type");
  if (!existsSync(path)) {
    return null;
  }
  const value = readFileSync(path, "utf-8").trim();
  return value === "deb" || value === "rpm" ? value : null;
}

async function isRegisteredAtRunningLocation(
  packageType: LinuxPackageType,
): Promise<boolean> {
  const queryCommand = packageType === "deb" ? "dpkg" : "rpm";
  const queryArgs = packageType === "deb" ? ["-S"] : ["-qf"];
  const resolvedExecPath = await realpath(process.execPath).catch(
    () => process.execPath,
  );
  return execFileAsync(queryCommand, [...queryArgs, resolvedExecPath], {
    timeout: REGISTRATION_QUERY_TIMEOUT_MS,
  }).then(
    () => true,
    () => false,
  );
}

export async function resolveLinuxSilentInstallSupported(
  packageType: LinuxPackageType,
): Promise<boolean> {
  if (isWsl()) {
    return false;
  }
  return isRegisteredAtRunningLocation(packageType);
}

export function buildLinuxUpdateGuidance(
  packageType: LinuxPackageType,
  latestVersion: string | null,
  downloadedFile: string | null,
): DesktopAppUpdateGuidance {
  const versionLabel =
    latestVersion === null ? "the update" : `v${latestVersion}`;
  const command =
    downloadedFile === null
      ? null
      : packageType === "deb"
        ? `sudo dpkg -i "${downloadedFile}"`
        : `sudo rpm -U "${downloadedFile}"`;
  return {
    summary: `Traycer downloaded ${versionLabel}, but this install can't apply it automatically - one manual step finishes it.`,
    steps: [
      "Open a terminal.",
      "Run the command below to install the update.",
      "Restart Traycer once it completes.",
    ],
    command,
    releaseUrl: DESKTOP_RELEASES_URL,
  };
}

/** `LinuxUpdater.spawnSyncLog` throws `Command <cmd> exited with code <n>` (the real stderr is only logged, never included in the message). */
const LINUX_ESCALATION_COMMANDS: readonly string[] = [
  "pkexec",
  "sudo",
  "gksudo",
  "kdesudo",
  "beesu",
  "dpkg",
  "apt-get",
  "apt",
  "rpm",
  "dnf",
  "yum",
  "zypper",
];

const LINUX_ESCALATION_ERROR_HINTS: readonly string[] = [
  ...LINUX_ESCALATION_COMMANDS.map((command) => `command ${command} exited`),
  "neither dpkg nor apt",
];

export function isLinuxEscalationError(rawMessage: string): boolean {
  const message = rawMessage.toLowerCase();
  return LINUX_ESCALATION_ERROR_HINTS.some((hint) => message.includes(hint));
}
