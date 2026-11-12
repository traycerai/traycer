import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  credentialsWrite,
  errorCode,
  withCredentialsWrites,
} from "./credentials-fs";
import { withCredentialsLock } from "./credentials-lock";

const PIECE_COUNT = 16;
const PIECE_BYTES = 64 * 1024;

export async function isCredentialsReserveComplete(
  credentialsPath: string,
): Promise<boolean> {
  for (let index = 0; index < PIECE_COUNT; index += 1) {
    try {
      const piece = await stat(`${credentialsPath}.reserve.${index}`);
      if (!piece.isFile() || piece.size !== PIECE_BYTES) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export class CredentialsReserve {
  private active = 0;
  private generation = 0;
  private filling = false;
  private refillRequested = false;
  private disposed = false;

  constructor(
    private readonly credentialsPath: string,
    private readonly lockPath: string,
  ) {
    this.replenish();
  }

  begin(): void {
    this.active += 1;
    this.generation += 1;
    this.refillRequested = false;
  }

  end(refill: boolean): void {
    this.active -= 1;
    if (refill && this.active === 0) this.replenish();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  async probe(interrupted: (() => boolean) | null): Promise<boolean> {
    if (interrupted?.()) return false;
    await credentialsWrite(() =>
      mkdir(dirname(this.credentialsPath), { recursive: true, mode: 0o700 }),
    );
    if (interrupted?.()) return false;
    const path = `${this.credentialsPath}.space-check.${randomUUID()}.tmp`;
    try {
      await credentialsWrite(() =>
        writeFile(path, randomBytes(PIECE_BYTES), {
          mode: 0o600,
          flush: true,
        }),
      );
    } finally {
      await credentialsWrite(() => unlink(path)).catch((err: unknown) => {
        if (errorCode(err) !== "ENOENT") throw err;
      });
    }
    return !interrupted?.();
  }

  async release(): Promise<boolean> {
    for (let index = 0; index < PIECE_COUNT; index += 1) {
      try {
        await unlink(`${this.credentialsPath}.reserve.${index}`);
        return true;
      } catch (err) {
        if (errorCode(err) !== "ENOENT") return false;
      }
    }
    return false;
  }

  private replenish(): void {
    if (this.disposed || this.active !== 0) return;
    if (this.filling) {
      this.refillRequested = true;
      return;
    }
    this.filling = true;
    const generation = this.generation;
    setImmediate(() => {
      void withCredentialsWrites(undefined, () =>
        this.fill(generation),
      ).finally(() => {
        this.filling = false;
        if (this.refillRequested) {
          this.refillRequested = false;
          this.replenish();
        }
      });
    });
  }

  private async fill(generation: number): Promise<void> {
    const interrupted = (): boolean =>
      this.disposed || this.active !== 0 || generation !== this.generation;
    try {
      if (interrupted()) return;
      const missing: number[] = [];
      for (let index = 0; index < PIECE_COUNT; index += 1) {
        if (interrupted()) return;
        try {
          const piece = await stat(`${this.credentialsPath}.reserve.${index}`);
          if (interrupted()) return;
          if (piece.size !== PIECE_BYTES) missing.push(index);
        } catch (err) {
          if (errorCode(err) !== "ENOENT") return;
          missing.push(index);
        }
      }
      if (missing.length === 0 || interrupted()) return;
      await withCredentialsLock(
        {
          lockPath: this.lockPath,
          reason: "credentials-reserve",
          waitMs: 0,
          pollIntervalMs: 25,
          signal: null,
        },
        async () => {
          if (interrupted() || !(await this.probe(interrupted))) return;
          for (const index of missing) {
            if (interrupted()) return;
            const path = `${this.credentialsPath}.reserve.${index}`;
            try {
              try {
                const existing = await stat(path);
                if (interrupted()) return;
                if (existing.size === PIECE_BYTES) continue;
                await unlink(path);
              } catch (err) {
                if (errorCode(err) !== "ENOENT") return;
              }
              if (interrupted()) return;
              await writeFile(path, randomBytes(PIECE_BYTES), {
                flag: "wx",
                mode: 0o600,
                flush: true,
              });
            } catch (err) {
              if (errorCode(err) === "EEXIST") continue;
              await unlink(path).catch(() => {});
              return;
            }
          }
        },
      );
    } catch {
      // Best effort: allocating the reserve must never fail a store operation.
    }
  }
}
