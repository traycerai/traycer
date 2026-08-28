import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveStrict = vi.hoisted(() => vi.fn());

vi.mock("../json-file-store", () => ({
  createJsonFileStore: vi.fn(() => ({
    flush: vi.fn(),
    load: vi.fn().mockResolvedValue({ allowPrerelease: false }),
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
  userDataPath = mkdtempSync(join(tmpdir(), "traycer-update-preferences-"));
  saveStrict.mockReset();
  vi.resetModules();
});

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("update preference persistence failures", () => {
  it("rejects when writing the preference fails and preserves memory", async () => {
    const filesystemError = new Error("disk full");
    saveStrict.mockRejectedValue(filesystemError);
    const preferences = await import("../update-preferences");

    await preferences.hydrateUpdatePreferences();
    const failure = await preferences.setPrereleaseUpdatesEnabled(true).then(
      () => null,
      (error) => error,
    );

    expect(failure).toBeInstanceOf(
      preferences.UpdatePreferencePersistenceError,
    );
    expect(failure).toMatchObject({
      code: preferences.UPDATE_PREFERENCE_PERSISTENCE_ERROR_CODE,
      cause: filesystemError,
    });
    expect(saveStrict).toHaveBeenCalledWith({ allowPrerelease: true });
    expect(preferences.prereleaseUpdatesEnabled()).toBe(false);
    expect(preferences.getUpdateChannelSnapshot()).toEqual({
      allowPrerelease: false,
      generation: 0,
    });
  });

  it("rejects when renaming the preference fails and preserves memory", async () => {
    const filesystemError = new Error("permission denied");
    saveStrict.mockRejectedValue(filesystemError);
    const preferences = await import("../update-preferences");

    await preferences.hydrateUpdatePreferences();
    const failure = await preferences.setPrereleaseUpdatesEnabled(true).then(
      () => null,
      (error) => error,
    );

    expect(failure).toBeInstanceOf(
      preferences.UpdatePreferencePersistenceError,
    );
    expect(failure).toMatchObject({
      code: preferences.UPDATE_PREFERENCE_PERSISTENCE_ERROR_CODE,
      cause: filesystemError,
    });
    expect(saveStrict).toHaveBeenCalledWith({ allowPrerelease: true });
    expect(preferences.prereleaseUpdatesEnabled()).toBe(false);
    expect(preferences.getUpdateChannelSnapshot()).toEqual({
      allowPrerelease: false,
      generation: 0,
    });
  });
});
