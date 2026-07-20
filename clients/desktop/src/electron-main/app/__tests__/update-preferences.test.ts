import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userDataPath: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataPath,
  },
}));

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "traycer-update-preferences-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("update preferences", () => {
  it("defaults prerelease updates off", async () => {
    const preferences = await import("../update-preferences");

    await preferences.hydrateUpdatePreferences();

    expect(preferences.prereleaseUpdatesEnabled()).toBe(false);
  });

  it("persists an explicit opt-in across module reloads", async () => {
    const first = await import("../update-preferences");
    await first.setPrereleaseUpdatesEnabled(true);

    vi.resetModules();
    const reloaded = await import("../update-preferences");
    await reloaded.hydrateUpdatePreferences();

    expect(reloaded.prereleaseUpdatesEnabled()).toBe(true);
  });

  // Cold-review finding 5: durable preference generation is the epoch Host
  // admission binds to. It must advance only on actual channel transitions.
  it("increments the process-local generation on every actual channel change", async () => {
    const preferences = await import("../update-preferences");
    await preferences.hydrateUpdatePreferences();

    const initial = preferences.getUpdateChannelSnapshot();
    expect(initial).toEqual({ allowPrerelease: false, generation: 0 });

    await preferences.setPrereleaseUpdatesEnabled(true);
    const afterOptIn = preferences.getUpdateChannelSnapshot();
    expect(afterOptIn).toEqual({ allowPrerelease: true, generation: 1 });

    await preferences.setPrereleaseUpdatesEnabled(false);
    const afterOptOut = preferences.getUpdateChannelSnapshot();
    expect(afterOptOut).toEqual({ allowPrerelease: false, generation: 2 });
  });

  it("does not bump generation when the requested channel is already current", async () => {
    const preferences = await import("../update-preferences");
    await preferences.hydrateUpdatePreferences();

    await preferences.setPrereleaseUpdatesEnabled(false);
    expect(preferences.getUpdateChannelSnapshot()).toEqual({
      allowPrerelease: false,
      generation: 0,
    });

    await preferences.setPrereleaseUpdatesEnabled(true);
    await preferences.setPrereleaseUpdatesEnabled(true);
    expect(preferences.getUpdateChannelSnapshot()).toEqual({
      allowPrerelease: true,
      generation: 1,
    });
  });

  // ABA: A → B → A must not make work captured under the first A look current.
  // Generation is process-local and strictly monotonic for actual changes.
  it("survives an ABA channel change (A→B→A) without reusing the first generation", async () => {
    const preferences = await import("../update-preferences");
    await preferences.hydrateUpdatePreferences();

    const firstA = preferences.getUpdateChannelSnapshot();
    expect(firstA).toEqual({ allowPrerelease: false, generation: 0 });

    await preferences.setPrereleaseUpdatesEnabled(true);
    const b = preferences.getUpdateChannelSnapshot();
    expect(b).toEqual({ allowPrerelease: true, generation: 1 });

    await preferences.setPrereleaseUpdatesEnabled(false);
    const secondA = preferences.getUpdateChannelSnapshot();
    expect(secondA.allowPrerelease).toBe(false);
    expect(secondA.generation).toBe(2);
    expect(secondA.generation).not.toBe(firstA.generation);
  });
});
