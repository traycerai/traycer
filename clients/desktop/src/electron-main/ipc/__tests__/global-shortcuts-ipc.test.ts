import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// Amended decision 3 (added after PR #533 review): structural validity (a
// string) isn't semantic validity - `parseGlobalShortcutIntent` must reject a
// non-canonical chord string (e.g. "mod+", wrong token order, an unsupported
// key) with a typed rejection at the IPC boundary, rather than letting it
// reach `applyGlobalShortcutIntent`/`reconcile()`/Electron unchanged.

const shortcuts = vi.hoisted(() => ({
  applyGlobalShortcutIntent: vi.fn(),
  getGlobalShortcutsSnapshot: vi.fn(),
  onGlobalShortcutsChange: vi.fn(() => () => undefined),
}));

const preferenceErrors = vi.hoisted(() => ({
  isGlobalShortcutPersistenceError: vi.fn(),
}));

const logger = vi.hoisted(() => ({
  describeLogError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/shortcuts", () => ({
  applyGlobalShortcutIntent: shortcuts.applyGlobalShortcutIntent,
  getGlobalShortcutsSnapshot: shortcuts.getGlobalShortcutsSnapshot,
  onGlobalShortcutsChange: shortcuts.onGlobalShortcutsChange,
}));

vi.mock("../../app/global-shortcuts-preferences", () => ({
  isGlobalShortcutPersistenceError:
    preferenceErrors.isGlobalShortcutPersistenceError,
}));

vi.mock("../../app/logger", () => logger);

interface FakeBridge {
  readonly handlers: Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >;
  readonly fanOut: Mock;
  readonly disposeFns: Array<() => void>;
  handleInvoke(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
}

function makeBridge(): FakeBridge {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >();
  return {
    handlers,
    fanOut: vi.fn(),
    disposeFns: [],
    handleInvoke(channel, handler) {
      handlers.set(channel, async (event, ...args) => handler(event, ...args));
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  shortcuts.applyGlobalShortcutIntent.mockReset();
  shortcuts.getGlobalShortcutsSnapshot.mockReset();
  shortcuts.onGlobalShortcutsChange
    .mockReset()
    .mockReturnValue(() => undefined);
  preferenceErrors.isGlobalShortcutPersistenceError.mockReset();
  logger.describeLogError.mockClear();
  logger.log.debug.mockReset();
  logger.log.info.mockReset();
  logger.log.warn.mockReset();
  logger.log.error.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function invokeSet(
  id: unknown,
  intent: unknown,
): Promise<{ readonly bridge: FakeBridge; readonly result: Promise<unknown> }> {
  const { registerGlobalShortcutsIpc } =
    await import("../global-shortcuts-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerGlobalShortcutsIpc(bridge as never);
  const handler = bridge.handlers.get(RunnerHostInvoke.globalShortcutsSet);
  if (handler === undefined) {
    throw new Error("globalShortcutsSet handler was not registered");
  }
  return { bridge, result: handler(null, id, intent) };
}

describe("global-shortcuts IPC - semantic chord validation at the boundary", () => {
  it("rejects a chord with a trailing plus (empty key) instead of silently coercing it", async () => {
    const { result } = await invokeSet("summon", {
      enabled: true,
      chord: "mod+",
    });

    await expect(result).rejects.toThrow(
      "Malformed global shortcut intent: chord is not valid",
    );
    expect(shortcuts.applyGlobalShortcutIntent).not.toHaveBeenCalled();
  });

  it("rejects non-canonical token order instead of silently coercing it", async () => {
    const { result } = await invokeSet("summon", {
      enabled: true,
      chord: "shift+mod+a",
    });

    await expect(result).rejects.toThrow(
      "Malformed global shortcut intent: chord is not valid",
    );
    expect(shortcuts.applyGlobalShortcutIntent).not.toHaveBeenCalled();
  });

  it("rejects an unsupported key instead of silently coercing it", async () => {
    const { result } = await invokeSet("summon", {
      enabled: true,
      chord: "mod+shift+foobar",
    });

    await expect(result).rejects.toThrow(
      "Malformed global shortcut intent: chord is not valid",
    );
    expect(shortcuts.applyGlobalShortcutIntent).not.toHaveBeenCalled();
  });

  it("still accepts a valid canonical chord and forwards it to applyGlobalShortcutIntent", async () => {
    shortcuts.applyGlobalShortcutIntent.mockResolvedValue({
      id: "summon",
      intent: { enabled: true, chord: "mod+alt+k" },
      effectiveChord: "mod+alt+k",
      status: "registered",
    });

    const { result } = await invokeSet("summon", {
      enabled: true,
      chord: "mod+alt+k",
    });

    await expect(result).resolves.toMatchObject({ status: "registered" });
    expect(shortcuts.applyGlobalShortcutIntent).toHaveBeenCalledWith("summon", {
      enabled: true,
      chord: "mod+alt+k",
    });
  });

  it("accepts a null chord (meaning: use the definition's default) without validation", async () => {
    shortcuts.applyGlobalShortcutIntent.mockResolvedValue({
      id: "summon",
      intent: { enabled: true, chord: null },
      effectiveChord: "mod+shift+space",
      status: "registered",
    });

    const { result } = await invokeSet("summon", {
      enabled: true,
      chord: null,
    });

    await expect(result).resolves.toMatchObject({ status: "registered" });
    expect(shortcuts.applyGlobalShortcutIntent).toHaveBeenCalledWith("summon", {
      enabled: true,
      chord: null,
    });
  });

  it("rejects a malformed id", async () => {
    const { result } = await invokeSet("not-a-real-id", {
      enabled: true,
      chord: null,
    });

    await expect(result).rejects.toThrow("Unknown global shortcut id");
    expect(shortcuts.applyGlobalShortcutIntent).not.toHaveBeenCalled();
  });
});
