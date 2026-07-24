import { existsSync, readFileSync } from "node:fs";

/**
 * WSL detection shared by update guidance (WSLg sessions can't run a GUI
 * `sudo` - see `resolveLinuxSilentInstallSupported`) and the core-dump guard
 * (WSL's crash capture has no size cap). A plain `/proc/version` read (no
 * subprocess) is the authoritative signal; the env vars are a cheap
 * supplementary fast path, not fully guaranteed to propagate through every
 * WSLg GUI-launch path.
 */
export function isWsl(): boolean {
  if (
    process.env["WSL_DISTRO_NAME"] !== undefined ||
    process.env["WSL_INTEROP"] !== undefined
  ) {
    return true;
  }
  if (!existsSync("/proc/version")) {
    return false;
  }
  return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
}
