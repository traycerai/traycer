import type { ISecureStorage } from "../platform/runner-host";
import type { HostTokenPersistence } from "./host-token-source";
import {
  parseHostTokenFile,
  serializeHostTokenFile,
  type HostTokenTable,
} from "./host-token-store";

function readTable(raw: string | null): HostTokenTable {
  if (raw === null) return new Map();
  try {
    return parseHostTokenFile(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

/**
 * The host-only tokens in one secure-storage entry beside the sign-in
 * credentials. One runtime writes it, so updates are only ordered, not locked.
 */
export function createSecureStorageHostTokenPersistence(
  storage: ISecureStorage,
  key: string,
): HostTokenPersistence {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    load: async () => readTable(await storage.get(key)),
    update: (change) => {
      const run = queue.then(async () => {
        const latest = readTable(await storage.get(key));
        const next = change(latest);
        if (next !== latest)
          await storage.set(key, JSON.stringify(serializeHostTokenFile(next)));
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
