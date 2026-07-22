import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveStrict = vi.hoisted(() => vi.fn());

vi.mock("../json-file-store", () => ({
  createJsonFileStore: vi.fn(() => ({
    flush: vi.fn(),
    load: vi.fn().mockResolvedValue({ summon: { enabled: true, chord: null } }),
    save: vi.fn(),
    saveStrict,
  })),
}));

let userDataPath: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataPath,
  },
}));

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "traycer-global-shortcuts-"));
  saveStrict.mockReset();
  vi.resetModules();
});

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("global shortcut preference persistence failures", () => {
  it("rejects with GlobalShortcutPersistenceError when the write fails, and preserves the in-memory intent", async () => {
    const filesystemError = new Error("disk full");
    saveStrict.mockRejectedValue(filesystemError);
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();
    const failure = await preferences
      .setGlobalShortcutIntent("summon", {
        enabled: false,
        chord: "mod+alt+space",
      })
      .then(
        () => null,
        (error) => error,
      );

    expect(failure).toBeInstanceOf(preferences.GlobalShortcutPersistenceError);
    expect(failure).toMatchObject({
      code: preferences.GLOBAL_SHORTCUT_PERSISTENCE_ERROR_CODE,
      cause: filesystemError,
    });
    expect(saveStrict).toHaveBeenCalledWith({
      summon: { enabled: false, chord: "mod+alt+space" },
    });
    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: true,
      chord: null,
    });
  });

  it("retries persistence on a repeated mutation after a prior write failure, rather than treating it as already applied", async () => {
    const filesystemError = new Error("permission denied");
    saveStrict.mockRejectedValue(filesystemError);
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();
    const failure = await preferences
      .setGlobalShortcutIntent("summon", { enabled: true, chord: "mod+x" })
      .then(
        () => null,
        (error) => error,
      );

    expect(preferences.isGlobalShortcutPersistenceError(failure)).toBe(true);
    saveStrict.mockClear();
    await preferences
      .setGlobalShortcutIntent("summon", { enabled: true, chord: "mod+x" })
      .catch(() => undefined);
    expect(saveStrict).toHaveBeenCalledTimes(1);
  });
});
