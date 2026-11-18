import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./logger";

/**
 * Atomic file rewrite + serialized write chain. A crash mid-write leaves
 * either the previous file intact or the new one - never a half-written
 * blob. Without this, a `writeFile` can corrupt a JSON store on power loss
 * (cert allowlist, gpu pref, etc.).
 */
export interface JsonFileStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
  flush(): Promise<void>;
}

/**
 * A JSON store that lets safety-sensitive callers observe a failed durable
 * write. `save` remains best-effort for existing consumers.
 */
export interface StrictJsonFileStore<T> extends JsonFileStore<T> {
  saveStrict(value: T): Promise<void>;
}

export function createJsonFileStore<T>(
  filePath: string,
  fallback: T,
  parse: (value: unknown) => T,
): StrictJsonFileStore<T> {
  let writeChain: Promise<unknown> = Promise.resolve();
  let dirEnsured = false;

  async function persist(value: T): Promise<void> {
    if (!dirEnsured) {
      await mkdir(dirname(filePath), { recursive: true });
      dirEnsured = true;
    }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  }

  return {
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        return parse(JSON.parse(raw));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn("[json-store] load failed", { filePath, err });
        }
        return fallback;
      }
    },
    async save(value: T) {
      const next = writeChain.then(() => persist(value));
      writeChain = next.catch((err) => {
        log.warn("[json-store] persist failed", { filePath, err });
      });
      await writeChain;
    },
    async saveStrict(value: T) {
      const next = writeChain.then(() => persist(value));
      writeChain = next.catch((err) => {
        log.warn("[json-store] persist failed", { filePath, err });
      });
      await next;
    },
    flush() {
      return writeChain.then(() => undefined);
    },
  };
}
