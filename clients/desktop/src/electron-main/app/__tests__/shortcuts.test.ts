import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toAccelerator } from "@traycer-clients/shared/keybindings/chord-core";
import type { GlobalShortcutIntent } from "../../../ipc-contracts/global-shortcuts-types";
import {
  WindowRegistry,
  type RegistryManagedWindow,
} from "../../windows/window-registry";
import type { ShortcutTargetWindow } from "../shortcuts";

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
  it("exposes a complete disabled snapshot before startup reconcile", async () => {
    const shortcuts = await import("../shortcuts");

    expect(shortcuts.getGlobalShortcutsSnapshot()).toEqual({
      sequence: 0,
      statuses: {
        summon: {
          id: "summon",
          intent: DEFAULT_INTENT,
          effectiveChord: "mod+shift+space",
          status: "disabled",
        },
      },
    });
  });

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

  it("registers a changed accelerator before releasing the previous one (acquire before release)", async () => {
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
    // Amended decision 7 (acquire before release): the new accelerator is
    // registered while the old one is still held, and the old is only
    // released after - never the reverse, which would leave a window with
    // no working chord at all if the new registration were then refused.
    const unregisterOrder = electron.unregister.mock.invocationCallOrder[0];
    const registerOrder = electron.register.mock.invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(unregisterOrder);
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(newAccelerator);
  });

  it("does not touch the OS when the effective accelerator is unchanged", async () => {
    const shortcuts = await import("../shortcuts");
    await shortcuts.reconcileGlobalShortcuts({});
    electron.register.mockClear();
    electron.unregister.mockClear();

    await shortcuts.reconcileGlobalShortcuts({});

    expect(electron.register).not.toHaveBeenCalled();
    expect(electron.unregister).not.toHaveBeenCalled();
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );
  });

  it("never releases the previous accelerator when the new registration is refused", async () => {
    const shortcuts = await import("../shortcuts");
    await shortcuts.reconcileGlobalShortcuts({});
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );

    preferences.intents.summon = { enabled: true, chord: "mod+alt+x" };
    electron.register.mockClear();
    electron.unregister.mockClear();
    electron.register.mockReturnValueOnce(false);

    const snapshot = await shortcuts.reconcileGlobalShortcuts({});

    expect(snapshot.statuses.summon.status).toBe("rejected");
    expect(electron.unregister).not.toHaveBeenCalled();
    // The old accelerator is still what's actually registered - the user is
    // never left with no working chord.
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );
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

  // Review P1: only disk writes were serialized, so a rejected window-1
  // rebind and an accepted window-2 rebind could interleave their trial and
  // rollback reads. Amended decision 7 moves the ENTIRE transaction (trial,
  // persist-or-revert, fan-out) onto one queue. This reproduces the
  // reviewer's mermaid scenario: window 1's rebind is refused by the OS,
  // window 2's rebind is accepted with its persistence write deliberately
  // held open, both fired without awaiting either first.
  it("serializes end to end: window 2's OS registration never starts until window 1's rejected transaction fully settles", async () => {
    const shortcuts = await import("../shortcuts");
    await shortcuts.reconcileGlobalShortcuts({});
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );

    const rejectedAccelerator = toAccelerator("mod+alt+b", platform);
    const acceptedAccelerator = toAccelerator("mod+alt+c", platform);

    let w1Settled = false;
    let acceptedRegisteredBeforeW1Settled = false;
    electron.register.mockImplementation((accelerator: string) => {
      if (accelerator === acceptedAccelerator && !w1Settled) {
        acceptedRegisteredBeforeW1Settled = true;
      }
      return accelerator !== rejectedAccelerator;
    });

    const window2Persist: { release: (() => void) | null } = { release: null };
    const window2PersistHeldOpen = new Promise<void>((resolve) => {
      window2Persist.release = resolve;
    });
    preferences.set.mockImplementation(
      async (id: string, intent: GlobalShortcutIntent) => {
        // Window 2's disk write is deliberately held open - if the queue
        // didn't serialize the whole transaction, window 1's trial/rollback
        // could interleave in this gap instead of having already finished.
        await window2PersistHeldOpen;
        preferences.intents[id] = intent;
      },
    );

    const p1 = shortcuts
      .applyGlobalShortcutIntent("summon", {
        enabled: true,
        chord: "mod+alt+b",
      })
      .then((status) => {
        w1Settled = true;
        return status;
      });
    const p2 = shortcuts.applyGlobalShortcutIntent("summon", {
      enabled: true,
      chord: "mod+alt+c",
    });

    // Flush microtasks so window 1 (which has no pending external promise)
    // gets every chance to run to completion while window 2 stays blocked
    // on its held-open persistence write.
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(w1Settled).toBe(true);
    // Window 2 never even attempted its OS registration before window 1
    // fully settled - proof the queue serialized the whole transaction, not
    // just the disk write.
    expect(acceptedRegisteredBeforeW1Settled).toBe(false);

    window2Persist.release?.();
    const [status1, status2] = await Promise.all([p1, p2]);

    expect(status1.status).toBe("rejected");
    expect(status2.status).toBe("registered");
    // No split-brain: OS state, persisted intent, and the returned status
    // all agree on window 2's accepted chord as the final winner.
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      acceptedAccelerator,
    );
    expect(preferences.intents.summon).toEqual({
      enabled: true,
      chord: "mod+alt+c",
    });
    expect(
      shortcuts.getGlobalShortcutsSnapshot().statuses.summon,
    ).toMatchObject({
      status: "registered",
      effectiveChord: "mod+alt+c",
    });
  });

  // Review P3 blind spot: the prior concurrency test above made the FIRST
  // operation the rejected, non-persisting one and held only the SECOND
  // (accepted) operation's persistence open. That leaves a real hole -
  // moving just the persistence call outside `withGlobalShortcutsQueue`
  // would still pass it, since nothing there proves an ACCEPTED
  // transaction's OWN persistence write is inside the queue. This test
  // flips the roles: op1 is accepted (OS grants it) with its persistence
  // write held open, and while that write is still pending, op2 fires. If
  // the queue only serialized the disk write path shallowly (or somehow let
  // a second transaction's trial reconcile slip in during op1's held-open
  // write), op2's `globalShortcut.register` would fire before op1's
  // persistence settles.
  it("holds an accepted transaction's own persistence write inside the queue: a second transaction cannot attempt OS registration until it releases", async () => {
    const shortcuts = await import("../shortcuts");
    await shortcuts.reconcileGlobalShortcuts({});
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(
      DEFAULT_ACCELERATOR,
    );

    const op1Accelerator = toAccelerator("mod+alt+e", platform);
    const op2Accelerator = toAccelerator("mod+alt+f", platform);

    let op1PersistResolved = false;
    let op2RegisterAttemptedBeforeOp1PersistResolved = false;
    electron.register.mockImplementation((accelerator: string) => {
      if (accelerator === op2Accelerator && !op1PersistResolved) {
        op2RegisterAttemptedBeforeOp1PersistResolved = true;
      }
      return true;
    });

    const op1Persist: { release: (() => void) | null } = { release: null };
    const op1PersistHeldOpen = new Promise<void>((resolve) => {
      op1Persist.release = resolve;
    });
    preferences.set.mockImplementation(
      async (id: string, intent: GlobalShortcutIntent) => {
        if (intent.chord === "mod+alt+e") {
          // Op1's own accepted-path persistence write, held open - if the
          // queue didn't cover this step, op2's trial reconcile could slip
          // in through this exact gap.
          await op1PersistHeldOpen;
          op1PersistResolved = true;
        }
        preferences.intents[id] = intent;
      },
    );

    const p1 = shortcuts.applyGlobalShortcutIntent("summon", {
      enabled: true,
      chord: "mod+alt+e",
    });
    const p2 = shortcuts.applyGlobalShortcutIntent("summon", {
      enabled: true,
      chord: "mod+alt+f",
    });

    // Flush microtasks: op1's trial register + persist-call-start should have
    // run, but op1's persistence promise is still held open, so op2's
    // operation must not have started its own trial reconcile yet.
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(electron.register).toHaveBeenCalledWith(
      op1Accelerator,
      expect.any(Function),
    );
    expect(op2RegisterAttemptedBeforeOp1PersistResolved).toBe(false);
    expect(electron.register).not.toHaveBeenCalledWith(
      op2Accelerator,
      expect.any(Function),
    );

    op1Persist.release?.();
    const [status1, status2] = await Promise.all([p1, p2]);

    expect(status1.status).toBe("registered");
    expect(status2.status).toBe("registered");
    expect(electron.register).toHaveBeenCalledWith(
      op2Accelerator,
      expect.any(Function),
    );
    expect(shortcuts.getRegisteredAccelerator("summon")).toBe(op2Accelerator);
  });

  // P2's "failed rollback can strand the user" scenario, at its actual edge:
  // if nothing has ever been registered yet (fresh startup, no prior
  // reconcile), a rejected trial's "revert to previous" is not a no-op - it
  // has no already-held accelerator to just leave alone, so it must attempt
  // a real registration too, which can also be refused.
  it("never persists and reports rejected when both the trial and the revert-to-previous registration are refused", async () => {
    const shortcuts = await import("../shortcuts");
    electron.register.mockReturnValue(false);

    const result = await shortcuts.applyGlobalShortcutIntent("summon", {
      enabled: true,
      chord: "mod+alt+d",
    });

    expect(result.status).toBe("rejected");
    expect(preferences.set).not.toHaveBeenCalled();
    expect(shortcuts.getRegisteredAccelerator("summon")).toBeNull();
    expect(shortcuts.getGlobalShortcutsSnapshot().statuses.summon.status).toBe(
      "rejected",
    );
  });
});

describe("MRU resolver wiring (decision 10)", () => {
  // `createMruWindowProxy` (desktop-startup.ts) is module-private, so this
  // rebuilds the identical shape it hands to `initGlobalShortcutsRegistry`:
  // a `focus()` that delegates to `WindowRegistry.focusMru()` rather than
  // targeting a fixed window. What's under test is real - the registered
  // `globalShortcut.register` callback (`DEFINITIONS[0].run`, captured from
  // the mock) actually resolving through a real `WindowRegistry` and
  // focusing whichever window is currently most-recently-used.
  class FakeRegistryWindow implements RegistryManagedWindow {
    readonly webContents: { readonly id: number };
    private readonly listeners = new Map<string, Set<() => void>>();
    private destroyed = false;
    private visible = false;
    private minimized = false;
    focusCalls = 0;
    showCalls = 0;
    restoreCalls = 0;

    constructor(webContentsId: number) {
      this.webContents = { id: webContentsId };
    }

    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    focus(): void {
      this.focusCalls += 1;
      this.emit("focus");
    }
    getTitle(): string {
      return "";
    }
    isMaximized(): boolean {
      return false;
    }
    minimize(): void {
      this.minimized = true;
    }
    maximize(): void {}
    unmaximize(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFocused(): boolean {
      return false;
    }
    isVisible(): boolean {
      return this.visible;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    show(): void {
      this.showCalls += 1;
      this.visible = true;
      this.emit("show");
    }
    restore(): void {
      this.restoreCalls += 1;
      this.minimized = false;
    }
    on(event: string, listener: () => void): void {
      const bucket = this.listeners.get(event) ?? new Set<() => void>();
      bucket.add(listener);
      this.listeners.set(event, bucket);
    }
    off(event: string, listener: () => void): void {
      this.listeners.get(event)?.delete(listener);
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener();
      }
    }
  }

  function createMruWindowProxy(
    registry: WindowRegistry<FakeRegistryWindow>,
  ): ShortcutTargetWindow {
    const current = () => registry.getMruRecord()?.window ?? null;
    return {
      isDestroyed: () => {
        const window = current();
        return window === null || window.isDestroyed();
      },
      isVisible: () => current()?.isVisible() ?? false,
      isMinimized: () => current()?.isMinimized() ?? false,
      show: () => current()?.show(),
      restore: () => current()?.restore(),
      focus: () => {
        registry.focusMru();
      },
    };
  }

  it("focuses the most-recently-used window, not the first-inserted one, when the summon action fires", async () => {
    let nextWebContentsId = 1;
    const created: FakeRegistryWindow[] = [];
    const registry = new WindowRegistry<FakeRegistryWindow>({
      createWindow: () => {
        const window = new FakeRegistryWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async () => undefined,
    });
    const windowA = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    const windowB = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    // Third window, inserted last and never explicitly focused - its
    // presence rules out "always focuses the last-inserted window" as an
    // alternative explanation for the assertion below.
    await registry.create({ initialRoute: "/", beforeLoad: null });
    const [fakeA, fakeB, fakeC] = created;

    // Focus A, then B last - B is now MRU, and it is neither the
    // first-inserted (A) nor the last-inserted (C) window, so focusing B
    // specifically can only be explained by real MRU tracking.
    registry.focusById(windowA);
    registry.focusById(windowB);
    expect(registry.mostRecentlyFocusedId()).toBe(windowB);

    const shortcuts = await import("../shortcuts");
    shortcuts.initGlobalShortcutsRegistry(() => createMruWindowProxy(registry));
    await shortcuts.reconcileGlobalShortcuts({});

    const runCallback = electron.register.mock.calls[0]?.[1] as
      (() => void) | undefined;
    if (runCallback === undefined) {
      throw new Error("expected the summon definition's run callback");
    }

    const focusCallsBefore = {
      a: fakeA.focusCalls,
      b: fakeB.focusCalls,
      c: fakeC.focusCalls,
    };
    runCallback();

    expect(fakeB.focusCalls).toBe(focusCallsBefore.b + 1);
    expect(fakeA.focusCalls).toBe(focusCallsBefore.a);
    expect(fakeC.focusCalls).toBe(focusCallsBefore.c);
  });
});
