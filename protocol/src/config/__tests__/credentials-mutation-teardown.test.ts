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

// One entry per case directory: the case that installed a hold is the only one
// whose writer waits on it and the only one a release reaches.
const heldPieces = vi.hoisted(() => ({
  byDirectory: new Map<string, HeldPiece>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const [target, flags] = args;
      const path = String(target);
      const held =
        flags === "wx" && path.includes(".reserve.")
          ? [...heldPieces.byDirectory].find(
              ([directory, piece]) =>
                path.startsWith(directory + sep) && !piece.released,
            )?.[1]
          : undefined;
      if (held === undefined) return actual.open(...args);
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

function holdReservePiece(workDir: string): HeldPiece {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<string>();
  outcome.promise.catch(() => undefined);
  const piece: HeldPiece = {
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
  heldPieces.byDirectory.set(workDir, piece);
  return piece;
}

function releaseHeldWriter(workDir: string): void {
  heldPieces.byDirectory.get(workDir)?.release();
}

describe("credentials mutation store: a finished case's background writers", () => {
  const stores: CredentialsMutationStore[] = [];
  const workDirs: string[] = [];

  function startCase(): { workDir: string; store: CredentialsMutationStore } {
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
    return { workDir, store };
  }

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    for (const piece of heldPieces.byDirectory.values()) piece.release();
    heldPieces.byDirectory.clear();
    for (const workDir of workDirs) endCaseWorkDir(workDir);
    workDirs.length = 0;
  });

  it("keeps the directory of an ended case while its reserve refill is still creating a piece", async () => {
    const { workDir, store } = startCase();
    const held = holdReservePiece(workDir);
    await held.entered;

    store.dispose();
    endCaseWorkDir(workDir);
    expect(existsSync(workDir)).toBe(true);

    held.release();
    expect(await held.outcome).toBe(join(workDir, "credentials.reserve.0"));
  });

  it("releases an ended case's writer without touching the next case's held writer", async () => {
    const first = startCase();
    const firstHeld = holdReservePiece(first.workDir);
    await firstHeld.entered;
    first.store.dispose();
    endCaseWorkDir(first.workDir);

    const second = startCase();
    const secondHeld = holdReservePiece(second.workDir);
    await secondHeld.entered;

    releaseHeldWriter(first.workDir);
    expect(firstHeld.released).toBe(true);
    expect(secondHeld.released).toBe(false);
    expect(await firstHeld.outcome).toBe(
      join(first.workDir, "credentials.reserve.0"),
    );
    expect(existsSync(join(second.workDir, "credentials.reserve.0"))).toBe(
      false,
    );

    releaseHeldWriter(second.workDir);
    expect(await secondHeld.outcome).toBe(
      join(second.workDir, "credentials.reserve.0"),
    );
  });
});
