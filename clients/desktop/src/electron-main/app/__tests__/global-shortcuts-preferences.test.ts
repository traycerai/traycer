import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  userDataPath = mkdtempSync(join(tmpdir(), "traycer-global-shortcuts-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function storePath(): string {
  return join(userDataPath, "global-shortcuts.json");
}

describe("global shortcut preferences", () => {
  it("defaults to enabled with no custom chord when nothing is persisted", async () => {
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();

    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: true,
      chord: null,
    });
  });

  it("persists an explicit disable across module reloads", async () => {
    const first = await import("../global-shortcuts-preferences");
    await first.setGlobalShortcutIntent("summon", {
      enabled: false,
      chord: null,
    });

    vi.resetModules();
    const reloaded = await import("../global-shortcuts-preferences");
    await reloaded.hydrateGlobalShortcutIntents();

    expect(reloaded.getGlobalShortcutIntent("summon")).toEqual({
      enabled: false,
      chord: null,
    });
  });

  it("persists a custom chord across module reloads", async () => {
    const first = await import("../global-shortcuts-preferences");
    await first.setGlobalShortcutIntent("summon", {
      enabled: true,
      chord: "mod+alt+space",
    });

    vi.resetModules();
    const reloaded = await import("../global-shortcuts-preferences");
    await reloaded.hydrateGlobalShortcutIntents();

    expect(reloaded.getGlobalShortcutIntent("summon")).toEqual({
      enabled: true,
      chord: "mod+alt+space",
    });
  });

  it("does not persist a write when the requested intent is already current", async () => {
    const preferences = await import("../global-shortcuts-preferences");
    await preferences.hydrateGlobalShortcutIntents();

    await preferences.setGlobalShortcutIntent("summon", {
      enabled: true,
      chord: null,
    });

    expect(existsSync(storePath())).toBe(false);
  });

  it("a corrupt (unparsable) file never blocks startup and resolves to defaults", async () => {
    writeFileSync(storePath(), "{ not valid json", "utf8");
    const preferences = await import("../global-shortcuts-preferences");

    await expect(
      preferences.hydrateGlobalShortcutIntents(),
    ).resolves.toBeDefined();
    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: true,
      chord: null,
    });
  });

  it("malformed fields for a known id resolve to the default intent instead of throwing", async () => {
    writeFileSync(
      storePath(),
      JSON.stringify({ summon: { enabled: "yes", chord: 123 } }),
      "utf8",
    );
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();

    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: true,
      chord: null,
    });
  });

  // Amended decision 3: structural validation (the zod schema) only confirms
  // `chord` is a string or null - it says nothing about whether that string
  // is a canonical chord. `sanitizeChord` resolves an invalid chord to `null`
  // ("use the definition's default") while keeping the rest of the intent
  // (`enabled`) exactly as persisted - it must NOT fall back to the full
  // `DEFAULT_INTENT` (which would also silently flip `enabled` back to true).
  it("coerces an invalid persisted chord string to null while preserving the persisted enabled flag", async () => {
    writeFileSync(
      storePath(),
      JSON.stringify({ summon: { enabled: false, chord: "mod+" } }),
      "utf8",
    );
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();

    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: false,
      chord: null,
    });
  });

  it("loads a well-formed persisted intent verbatim", async () => {
    writeFileSync(
      storePath(),
      JSON.stringify({ summon: { enabled: false, chord: "mod+alt+space" } }),
      "utf8",
    );
    const preferences = await import("../global-shortcuts-preferences");

    await preferences.hydrateGlobalShortcutIntents();

    expect(preferences.getGlobalShortcutIntent("summon")).toEqual({
      enabled: false,
      chord: "mod+alt+space",
    });
  });
});
