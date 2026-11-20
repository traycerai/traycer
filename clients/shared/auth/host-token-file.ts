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

// Mode 0600, replaced atomically, written only under the credentials file's lock;
// shared by desktop main and the CLI, never a renderer.
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
