import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toAccelerator } from "@traycer-clients/shared/keybindings/chord-core";
import type { GlobalShortcutIntent } from "../../../ipc-contracts/global-shortcuts-types";

const electron = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterAll: vi.fn(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: electron.on },
  globalShortcut: {
    register: electron.register,
    unregister: electron.unregister,
    unregisterAll: electron.unregisterAll,
  },
}));

const preferences = vi.hoisted(() => ({
  intents: {} as Record<string, GlobalShortcutIntent>,
  hydrate: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../global-shortcuts-preferences", () => ({
  hydrateGlobalShortcutIntents: preferences.hydrate,
  getGlobalShortcutIntent: preferences.get,
  setGlobalShortcutIntent: preferences.set,
}));

vi.mock("../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `process.platform` on the machine running the suite decides which bucket
// `acceleratorPlatform()` picks - compute the expected Accelerator the same
// way the module under test does, rather than pinning a specific OS.
const platform: "mac" | "other" =
  process.platform === "darwin" ? "mac" : "other";
const DEFAULT_ACCELERATOR = toAccelerator("mod+shift+space", platform);

const DEFAULT_INTENT: GlobalShortcutIntent = { enabled: true, chord: null };

beforeEach(() => {
  vi.resetModules();
  preferences.intents = { summon: DEFAULT_INTENT };
  preferences.hydrate
    .mockReset()
    .mockImplementation(async () => preferences.intents);
  preferences.get
    .mockReset()
    .mockImplementation((id: string) => preferences.intents[id]);
  preferences.set
    .mockReset()
    .mockImplementation(async (id: string, intent: GlobalShortcutIntent) => {
      preferences.intents[id] = intent;
    });
  electron.register.mockReset().mockReturnValue(true);
  electron.unregister.mockReset();
  electron.unregisterAll.mockReset();
  electron.on.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileGlobalShortcuts", () => {
  it("registers the effective default chord and reports status registered when the OS accepts", async () => {
    const shortcuts = await import("../shortcuts");

    const snapshot = await shortcuts.reconcileGlobalShortcuts({});

    expect(electron.register).toHaveBeenCalledWith(
      DEFAULT_ACCELERATOR,
      expect.any(Function),
    );
    expect(snapshot.statuses.summon).toMatchObject({
      id: "summon",
      status: "registered",
      effectiveChord: "mod+shift+space",
    });
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );
  });

  it("never calls globalShortcut.register when the intent is disabled", async () => {
    preferences.intents.summon = { enabled: false, chord: null };
    const shortcuts = await import("../shortcuts");

    const snapshot = await shortcuts.reconcileGlobalShortcuts({});

    expect(electron.register).not.toHaveBeenCalled();
    expect(snapshot.statuses.summon.status).toBe("disabled");
    expect(shortcuts.getRegisteredAccelerator("summon")).toBeNull();
  });

  it("marks status rejected and records no registered accelerator when the OS refuses registration", async () => {
    electron.register.mockReturnValue(false);
    const shortcuts = await import("../shortcuts");

    const snapshot = await shortcuts.reconcileGlobalShortcuts({});

    expect(snapshot.statuses.summon.status).toBe("rejected");
    expect(shortcuts.getRegisteredAccelerator("summon")).toBeNull();
  });

  it("unregisters the previous accelerator before registering a changed chord on the next reconcile", async () => {
    const shortcuts = await import("../shortcuts");
    await shortcuts.reconcileGlobalShortcuts({});
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );

    preferences.intents.summon = { enabled: true, chord: "mod+alt+x" };
    electron.register.mockClear();
    electron.unregister.mockClear();
    const newAccelerator = toAccelerator("mod+alt+x", platform);

    await shortcuts.reconcileGlobalShortcuts({});

    expect(electron.unregister).toHaveBeenCalledWith(DEFAULT_ACCELERATOR);
    expect(electron.register).toHaveBeenCalledWith(
      newAccelerator,
      expect.any(Function),
    );
    const unregisterOrder = electron.unregister.mock.invocationCallOrder[0];
    const registerOrder = electron.register.mock.invocationCallOrder[0];
    expect(unregisterOrder).toBeLessThan(registerOrder);
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(newAccelerator);
  });
});

describe("applyGlobalShortcutIntent (transactional rebind)", () => {
  it("persists the new intent and returns status registered when the OS accepts the rebind", async () => {
    const shortcuts = await import("../shortcuts");
    const newIntent: GlobalShortcutIntent = {
      enabled: true,
      chord: "mod+alt+y",
    };

    const result = await shortcuts.applyGlobalShortcutIntent(
      "summon",
      newIntent,
    );

    expect(result.status).toBe("registered");
    expect(preferences.set).toHaveBeenCalledWith("summon", newIntent);
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      toAccelerator("mod+alt+y", platform),
    );
  });

  it("re-registers the previous chord and never persists the rejected attempt when the OS refuses the new chord", async () => {
    const shortcuts = await import("../shortcuts");
    // Establish the default chord as the currently-registered baseline.
    await shortcuts.reconcileGlobalShortcuts({});
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );

    const rejectedAccelerator = toAccelerator("mod+alt+z", platform);
    electron.register.mockImplementation(
      (accelerator: string) => accelerator !== rejectedAccelerator,
    );
    const attemptedIntent: GlobalShortcutIntent = {
      enabled: true,
      chord: "mod+alt+z",
    };

    const result = await shortcuts.applyGlobalShortcutIntent(
      "summon",
      attemptedIntent,
    );

    expect(result.status).toBe("rejected");
    // The rejected attempt is never written to disk.
    expect(preferences.set).not.toHaveBeenCalled();
    // The OS re-grants the previous chord rather than leaving the user with
    // nothing registered.
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );
    expect(preferences.get("summon")).toEqual(DEFAULT_INTENT);
  });
});
