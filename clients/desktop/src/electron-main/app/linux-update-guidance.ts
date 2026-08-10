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

// Bounds `dpkg -S`/`rpm -qf` in `isRegisteredAtRunningLocation`, which runs
// unconditionally on every cold Linux launch before update listeners are
// registered - a hang here (lock contention, etc.) must not hang the updater
// indefinitely. A timeout is treated the same as any other query failure:
// conservatively "not registered" (see the function's own doc comment).
const REGISTRATION_QUERY_TIMEOUT_MS = 5_000;

/**
 * `package-type` is written by app-builder-lib's `FpmTarget` only for deb/rpm
 * (and pacman, which we don't currently ship - see `build.linux.target` in
 * `package.json`); AppImage never gets this file, so it correctly falls
 * through to `null` and stays on electron-updater's default silent-update
 * path. Mirrors `canCheckForUpdates`'s existing `resourcesPath` file-presence
 * pattern in `updater.ts`.
 */
export function readLinuxPackageType(): LinuxPackageType | null {
  const path = join(process.resourcesPath, "package-type");
  if (!existsSync(path)) {
    return null;
  }
  const value = readFileSync(path, "utf-8").trim();
  return value === "deb" || value === "rpm" ? value : null;
}

/**
 * Resolves whether the package manager that owns `packageType` actually
 * tracks the binary we're running from - i.e. whether an in-place
 * `dpkg -i`/`rpm -U` upgrade would replace this exact process. A manually
 * unpacked install (never registered) answers "no" here even though
 * `package-type` says deb/rpm. Runs the query asynchronously (not
 * `spawnSync`, unlike electron-updater's own install-time calls): this runs
 * unconditionally on every cold launch rather than only at user-initiated
 * install/quit time, so it must not block the main process event loop.
 */
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

/**
 * UX gate, not a safety net: `updater.ts` unconditionally disables
 * `autoInstallOnAppQuit` for any deb/rpm build regardless of this result, so
 * a wrong answer here only costs the user a manual step, never a silent
 * failure. WSLg sessions typically have no session polkit authentication
 * agent and no TTY for a GUI-launched `sudo`, so `dpkg -i`/`rpm -U` via
 * `LinuxUpdater.runCommandWithSudoIfNeeded` reliably fails there - hence the
 * `isWsl` exclusion. Deliberately does not probe for a live polkit agent
 * (fragile across desktop environments, and would risk spawning a spurious
 * auth prompt on every launch) - WSL exclusion plus the registration check
 * cover the realistic split between "normal desktop Linux" and "can't
 * self-update".
 */
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

/**
 * `LinuxUpdater.spawnSyncLog` throws `Command <cmd> exited with code <n>`
 * (the real stderr is only logged, never included in the message) - `<cmd>`
 * is the escalation wrapper (`pkexec`/`sudo`/`gksudo`/`kdesudo`/`beesu`) when
 * not running as root, or the package manager itself
 * (`dpkg`/`apt-get`/`rpm`/`dnf`/`yum`/`zypper`) when already root or on a
 * fallback path. `DebUpdater` additionally hard-fails upfront with
 * "Neither dpkg nor apt command found" when neither binary exists.
 * Deliberately a separate list from `INSTALL_ERROR_HINTS` in `updater.ts`
 * (download/checksum failures) rather than folded into it - these are
 * install-time escalation failures, a different class of problem with a
 * different remedy (manual command, not "try again").
 */
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
