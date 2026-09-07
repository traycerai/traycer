import { existsSync, readFileSync } from "node:fs";

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
