import { arch as osArch, platform as osPlatform } from "node:os";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { HostPlatformKey } from "./types";

// Resolve the current OS/arch to the host registry's platform key.
// Throws SERVICE_UNSUPPORTED_PLATFORM for combinations we don't ship a
// host archive for - callers should surface the message verbatim
// rather than guessing a fallback platform.
export function currentHostPlatformKey(): HostPlatformKey {
  const platform = osPlatform();
  const arch = osArch();
  // Windows ships x64-only: there is no win-arm64 host (sherpa-onnx, the
  // on-device dictation engine, has no win-arm64 binary). Windows 11 on ARM
  // runs the x64 build under emulation, so resolve win32/arm64 to win32-x64
  // for both the host download and CLI self-resolution. macOS/Linux keep
  // their native arm64 builds.
  const resolvedArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const key = `${platform}-${resolvedArch}`;
  if (
    key === "darwin-arm64" ||
    key === "darwin-x64" ||
    key === "linux-arm64" ||
    key === "linux-x64" ||
    key === "win32-arm64" ||
    key === "win32-x64"
  ) {
    return key;
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `traycer does not ship a host for ${platform}/${arch} (expected darwin|linux|win32 × arm64|x64)`,
    details: { platform, arch },
    exitCode: 1,
  });
}
