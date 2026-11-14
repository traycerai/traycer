import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  errorCode,
  writeJsonFileAtomic,
} from "@traycer/protocol/config/credentials-fs";
import { withCredentialsLock } from "@traycer/protocol/config/credentials-lock";
import {
  cliCredentialsPath,
  type Environment,
} from "@traycer/protocol/config/paths";
import type { HostTokenPersistence } from "./host-token-source";
import {
  parseHostTokenFile,
  serializeHostTokenFile,
  type HostTokenTable,
} from "./host-token-store";

/**
 * `~/.traycer/cli/<env>/host-tokens`, beside the credentials file: each
 * person's host-only tokens and their ends, keyed by person and host, and
 * nothing else. Mode 0600, replaced atomically, and only ever written while
 * holding the credentials file's own lock. The desktop's main process and the
 * CLI read and write it; no renderer touches it.
 */
export function hostTokensPath(environment: Environment): string {
  return join(dirname(cliCredentialsPath(environment)), "host-tokens");
}

async function readTable(path: string): Promise<HostTokenTable> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }
  try {
    return parseHostTokenFile(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export function createHostTokenFilePersistence(options: {
  readonly environment: Environment;
  readonly lockWaitMs: number;
  readonly lockPollIntervalMs: number;
}): HostTokenPersistence {
  const path = hostTokensPath(options.environment);
  const lockPath = `${cliCredentialsPath(options.environment)}.lock`;
  return {
    load: () => readTable(path),
    update: async (change) => {
      const result = await withCredentialsLock(
        {
          lockPath,
          reason: "host-tokens",
          waitMs: options.lockWaitMs,
          pollIntervalMs: options.lockPollIntervalMs,
          signal: null,
        },
        async () => {
          const latest = await readTable(path);
          const next = change(latest);
          if (next !== latest)
            await writeJsonFileAtomic(
              path,
              serializeHostTokenFile(next),
              0o600,
            );
          return next;
        },
      );
      if (!result.acquired)
        throw new Error("The credentials lock stayed busy; nothing was saved");
      return result.value;
    },
  };
}
