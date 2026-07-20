import { execFile } from "node:child_process";
import { isConsentedHostChannelVersion } from "@traycer-clients/shared/platform/runner-host";
import { discoverCli, resolveBundledCliPath } from "./cli-discovery";
import type { TraycerCliInvocation } from "./traycer-cli";
import { log } from "../app/logger";

/**
 * Host update capability negotiation (RC update-channel review findings 4/6).
 *
 * Desktop always installs an exact registry target via `host update --release`.
 * Older authoritative external CLIs reject that flag, so we probe support and
 * intentionally fall back to a capable bundled CLI rather than the moving
 * stable pointer.
 */

const CAPABILITY_PROBE_TIMEOUT_MS = 3_000;

// Process-lifetime positive-only cache keyed by absolute binary path.
// Capable CLIs are sticky for the process (re-probing every update only
// adds latency). Negative results are never cached: package-manager
// upgrades often replace bytes at the same path, and a stale `false`
// would keep reporting the upgraded CLI as incapable until Desktop
// restarts.
const releaseSupportByBinary = new Set<string>();

export { isConsentedHostChannelVersion };

export function exactHostUpdateArgs(version: string): readonly string[] {
  return ["host", "update", "--release", version];
}

export class HostUpdateCliCapabilityError extends Error {
  readonly code = "HOST_UPDATE_CLI_CAPABILITY";

  constructor(message: string) {
    super(message);
    this.name = "HostUpdateCliCapabilityError";
  }
}

/**
 * Probe whether a CLI binary understands `host update --release` by reading
 * that subcommand's help text. Unknown options are not safe to dry-run (they
 * exit non-zero without installing, but may still hit busy-check / lock
 * paths), so help inspection is the load-bearing contract.
 */
export async function probeCliSupportsHostUpdateRelease(
  binaryPath: string,
): Promise<boolean> {
  if (releaseSupportByBinary.has(binaryPath)) return true;

  const supports = await new Promise<boolean>((resolve) => {
    execFile(
      binaryPath,
      ["host", "update", "--help"],
      {
        encoding: "utf8",
        timeout: CAPABILITY_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // Commander prints help to stdout on success; some builds may still
        // emit useful text on stderr when the process exits non-zero.
        const text = `${String(stdout)}\n${String(stderr)}`;
        if (error !== null && text.trim().length === 0) {
          resolve(false);
          return;
        }
        // Match the flag token, not free-form "release" prose.
        resolve(/(?:^|\s)--release(?:\s|<|=|$)/m.test(text));
      },
    );
  });

  if (supports) {
    releaseSupportByBinary.add(binaryPath);
  }
  return supports;
}

/** Test-only: drop the process-lifetime positive capability cache. */
export function clearHostUpdateCliCapabilityCache(): void {
  releaseSupportByBinary.clear();
}

/**
 * Resolve a CLI invocation that can perform an exact `host update --release`.
 *
 * Prefers the normal authoritative discovery order (manifest → PATH →
 * bundled). When the authoritative binary lacks `--release`, intentionally
 * selects a distinct capable bundled CLI. Never falls back to bare
 * `host update`.
 */
export async function resolveExactHostUpdateCli(): Promise<TraycerCliInvocation> {
  const discovered = await discoverCli();
  const primaryPath = discovered.kind === "none" ? null : discovered.binaryPath;

  if (primaryPath !== null) {
    if (await probeCliSupportsHostUpdateRelease(primaryPath)) {
      return { command: primaryPath, args: [] };
    }
    log.warn(
      "[host-update-cli] authoritative CLI lacks host update --release; trying bundled CLI",
      { primaryPath, discoveryKind: discovered.kind },
    );
  }

  const bundledPath = await resolveBundledCliPath();
  if (bundledPath !== null && bundledPath !== primaryPath) {
    if (await probeCliSupportsHostUpdateRelease(bundledPath)) {
      log.info(
        "[host-update-cli] using bundled CLI for exact host update --release",
        { bundledPath, skippedPrimaryPath: primaryPath },
      );
      return { command: bundledPath, args: [] };
    }
  }

  throw new HostUpdateCliCapabilityError(
    "Host update requires a Traycer CLI that supports `host update --release`. Upgrade the traycer CLI via your package manager, or reinstall Traycer Desktop so the bundled CLI can perform the update.",
  );
}
