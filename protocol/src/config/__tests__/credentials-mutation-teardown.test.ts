import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialsMutationStore,
  type CredentialsMutationStore,
} from "../credentials-mutation";
import { createCaseWorkDir, endCaseWorkDir } from "./credentials-run-root";

// Reload shared-worker modules so the reserve binds this file's fs/promises mock.
vi.hoisted(() => {
  vi.resetModules();
});

type HeldPiece = {
  readonly directory: string;
  readonly entered: Promise<void>;
  readonly markEntered: () => void;
  readonly gate: Promise<void>;
  readonly release: () => void;
  released: boolean;
  /** The path the real `open` created once released, or its rejection. */
  readonly outcome: Promise<string>;
  readonly landed: (path: string) => void;
  readonly failed: (error: unknown) => void;
};

const heldPiece = vi.hoisted(() => ({ current: null as HeldPiece | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const [target, flags] = args;
      const path = String(target);
      const held = heldPiece.current;
      if (
        held === null ||
        held.released ||
        flags !== "wx" ||
        !path.includes(".reserve.") ||
        !path.startsWith(held.directory + sep)
      ) {
        return actual.open(...args);
      }
      held.markEntered();
      await held.gate;
      try {
        const handle = await actual.open(...args);
        held.landed(path);
        return handle;
      } catch (error) {
        held.failed(error);
        throw error;
      }
    }),
  };
});

function holdReservePiece(directory: string): HeldPiece {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<string>();
  outcome.promise.catch(() => undefined);
  const piece: HeldPiece = {
    directory,
    entered: entered.promise,
    markEntered: entered.resolve,
    gate: gate.promise,
    release: () => {
      piece.released = true;
      gate.resolve();
    },
    released: false,
    outcome: outcome.promise,
    landed: outcome.resolve,
    failed: outcome.reject,
  };
  heldPiece.current = piece;
  return piece;
}

describe("credentials mutation store: a finished case's background writers", () => {
  const stores: CredentialsMutationStore[] = [];
  const workDirs: string[] = [];

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    heldPiece.current?.release();
    heldPiece.current = null;
    for (const workDir of workDirs) endCaseWorkDir(workDir);
    workDirs.length = 0;
  });

  it("keeps the directory of an ended case while its reserve refill is still creating a piece", async () => {
    const workDir = createCaseWorkDir("traycer-cred-mut-teardown-");
    workDirs.push(workDir);
    const store = createCredentialsMutationStore({
      paths: {
        credentialsPath: join(workDir, "credentials"),
        metaPath: join(workDir, "credentials.meta.json"),
        lockPath: join(workDir, "credentials.lock"),
      },
      onDiskPressure: null,
      refresh: async () => {
        throw new Error("no refresh in a teardown case");
      },
      lockWaitMs: 500,
      lockPollIntervalMs: 25,
      continuationRetryMs: 15,
    });
    stores.push(store);
    const held = holdReservePiece(workDir);
    await held.entered;

    store.dispose();
    endCaseWorkDir(workDir);
    expect(existsSync(workDir)).toBe(true);

    held.release();
    expect(await held.outcome).toBe(join(workDir, "credentials.reserve.0"));
  });
});
