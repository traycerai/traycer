import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserPersistenceDecisionStore,
  parseBrowserPersistenceRecord,
  UNDECIDED_BROWSER_PERSISTENCE_RECORD,
} from "../browser-persistence-decision";

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
  },
}));

vi.mock("../../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "traycer-persistence-"));
});

function filePath(name: string): string {
  return join(directory, name);
}

describe("browser persistence decision file", () => {
  it("reads a missing file as undecided", async () => {
    const store = createBrowserPersistenceDecisionStore(
      filePath("missing.json"),
    );
    await expect(store.read()).resolves.toEqual(
      UNDECIDED_BROWSER_PERSISTENCE_RECORD,
    );
  });

  it("round-trips every decision kind with its recorded backend", async () => {
    const path = filePath("round-trip.json");
    const store = createBrowserPersistenceDecisionStore(path);

    await store.write({
      decision: { kind: "enabled", decidedAt: 1_700_000_000_000 },
      storageBackend: "gnome_libsecret",
    });
    await expect(store.read()).resolves.toEqual({
      decision: { kind: "enabled", decidedAt: 1_700_000_000_000 },
      storageBackend: "gnome_libsecret",
    });

    await store.write({
      decision: { kind: "declined", decidedAt: 2 },
      storageBackend: null,
    });
    await expect(store.read()).resolves.toEqual({
      decision: { kind: "declined", decidedAt: 2 },
      storageBackend: null,
    });

    await store.write({
      decision: { kind: "relaunch-pending", decidedAt: 3 },
      storageBackend: null,
    });
    await expect(store.read()).resolves.toEqual({
      decision: { kind: "relaunch-pending", decidedAt: 3 },
      storageBackend: null,
    });
  });

  it("writes a versioned payload and leaves no temp file behind", async () => {
    const path = filePath("versioned.json");
    const store = createBrowserPersistenceDecisionStore(path);

    await store.write({
      decision: { kind: "enabled", decidedAt: 7 },
      storageBackend: null,
    });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      decision: { kind: "enabled", decidedAt: 7 },
      storageBackend: null,
    });
  });

  it("falls back to undecided for corrupt, unknown-shaped, or extra-key files", async () => {
    const path = filePath("corrupt.json");
    const store = createBrowserPersistenceDecisionStore(path);

    await writeFile(path, "{not json", "utf8");
    await expect(store.read()).resolves.toEqual(
      UNDECIDED_BROWSER_PERSISTENCE_RECORD,
    );

    await writeFile(
      path,
      JSON.stringify({ version: 1, decision: { kind: "yes" } }),
      "utf8",
    );
    await expect(store.read()).resolves.toEqual(
      UNDECIDED_BROWSER_PERSISTENCE_RECORD,
    );
  });

  it("rejects unknown keys, wrong versions, and unknown backends (strict schema)", () => {
    expect(
      parseBrowserPersistenceRecord({
        version: 1,
        decision: { kind: "undecided" },
        storageBackend: null,
        surprise: true,
      }),
    ).toEqual(UNDECIDED_BROWSER_PERSISTENCE_RECORD);

    expect(
      parseBrowserPersistenceRecord({
        version: 2,
        decision: { kind: "enabled", decidedAt: 1 },
        storageBackend: null,
      }),
    ).toEqual(UNDECIDED_BROWSER_PERSISTENCE_RECORD);

    expect(
      parseBrowserPersistenceRecord({
        version: 1,
        decision: { kind: "enabled", decidedAt: 1 },
        storageBackend: "keyring-of-the-future",
      }),
    ).toEqual(UNDECIDED_BROWSER_PERSISTENCE_RECORD);

    // `decidedAt` is required on every decided kind.
    expect(
      parseBrowserPersistenceRecord({
        version: 1,
        decision: { kind: "enabled" },
        storageBackend: null,
      }),
    ).toEqual(UNDECIDED_BROWSER_PERSISTENCE_RECORD);
  });
});
