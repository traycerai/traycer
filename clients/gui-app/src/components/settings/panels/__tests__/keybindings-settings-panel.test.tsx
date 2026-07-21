import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { GLOBAL_SHORTCUT_DEFAULT_CHORDS } from "@traycer-clients/shared/keybindings/global-shortcuts";
import type {
  DesktopGlobalShortcutsBridge,
  GlobalShortcutIntent,
  GlobalShortcutStatus,
} from "@/lib/windows/types";

// This suite exercises the real `KeybindingsSettingsPanel`, real
// `ChordCaptureCore`/`ChordCaptureInput`, and the real `useKeybindingStore` -
// per this repo's testing philosophy (clients/gui-app/AGENTS.md), only the
// actual external boundary (the desktop bridge, via `useSummonHotkey`) is
// mocked.
const platformMock = vi.hoisted(() => ({ isMac: false }));
vi.mock("@/lib/keybindings/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/platform")>();
  return { ...actual, isMac: () => platformMock.isMac };
});

interface SummonHotkeyMockState {
  bridge: DesktopGlobalShortcutsBridge | null;
  status: GlobalShortcutStatus | null;
}

const summonHotkeyMock = vi.hoisted((): { current: SummonHotkeyMockState } => ({
  current: { bridge: null, status: null },
}));

vi.mock("@/hooks/runner/use-summon-hotkey", () => ({
  useSummonHotkey: () => summonHotkeyMock.current,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeStatus(
  overrides: Partial<GlobalShortcutStatus>,
): GlobalShortcutStatus {
  return {
    id: "summon",
    intent: { enabled: true, chord: null },
    effectiveChord: "mod+shift+space",
    status: "registered",
    ...overrides,
  };
}

function makeBridge(
  set: (
    id: string,
    intent: GlobalShortcutIntent,
  ) => Promise<GlobalShortcutStatus>,
): DesktopGlobalShortcutsBridge {
  return {
    getSnapshot: vi.fn(),
    set: vi.fn(set),
    onChange: vi.fn(() => ({ dispose: () => undefined })),
  };
}

describe("KeybindingsSettingsPanel - Global shortcuts (T2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.isMac = false;
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    summonHotkeyMock.current = { bridge: null, status: null };
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render the Global shortcuts section when the desktop bridge is absent", () => {
    renderPanel();

    expect(screen.queryByText("Global shortcuts")).toBeNull();
  });

  it("renders the Global shortcuts section when the desktop bridge is present", () => {
    summonHotkeyMock.current = {
      bridge: makeBridge(() => Promise.resolve(makeStatus({}))),
      status: makeStatus({}),
    };

    renderPanel();

    expect(screen.getByText("Global shortcuts")).toBeTruthy();
    expect(screen.getByText("Summon Traycer")).toBeTruthy();
  });

  // R1: a disabled/dormant summon chord doesn't reserve itself in the
  // renderer conflict map, so a renderer action can claim the same chord
  // while summon is off. Re-enabling must not silently let the OS chord
  // swallow that renderer binding.
  it("blocks enabling summon when a renderer action already holds the same chord, and never calls bridge.set", () => {
    useKeybindingStore.setState({
      bindings: { ...getDefaultBindings(), "epic.new": "mod+shift+space" },
    });
    const set = vi.fn(() => Promise.resolve(makeStatus({})));
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({
        intent: { enabled: false, chord: null },
        status: "disabled",
        effectiveChord: "mod+shift+space",
      }),
    };

    renderPanel();
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable summon shortcut" }),
    );

    expect(set).not.toHaveBeenCalled();
    expect(
      screen.getByText('Already bound to "epic.new". Pick a different chord.'),
    ).toBeTruthy();
  });

  // R3: only the switch used to be gated on `mutation.isPending`; the
  // capture control must be gated too, or a user could fire an overlapping
  // rebind while a set-invoke is already in flight.
  it("disables every mutation trigger while a summon mutation is pending", async () => {
    const pendingSet: {
      release: ((status: GlobalShortcutStatus) => void) | null;
    } = { release: null };
    const set = vi.fn(
      () =>
        new Promise<GlobalShortcutStatus>((resolve) => {
          pendingSet.release = resolve;
        }),
    );
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({}),
    };

    renderPanel();
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable summon shortcut" }),
    );

    await waitFor(() => {
      expect(set).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByRole<HTMLButtonElement>("switch", {
        name: "Enable summon shortcut",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Rebind the summon shortcut",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Reset all to defaults",
      }).disabled,
    ).toBe(true);
    expect(screen.getByTestId("summon-hotkey-pending-indicator")).toBeTruthy();
    expect(
      screen.getByTestId("reset-keybindings-pending-indicator"),
    ).toBeTruthy();

    pendingSet.release?.(
      makeStatus({
        intent: { enabled: false, chord: null },
        status: "disabled",
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("switch", {
          name: "Enable summon shortcut",
        }).disabled,
      ).toBe(false);
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Reset all to defaults",
        }).disabled,
      ).toBe(false);
    });
  });

  // R4: the summon mutation is lifted so "Reset all to defaults" can share
  // it - a disabled/customized summon chord must reset alongside the
  // renderer bindings the button visually sits below.
  it("resets the summon shortcut to defaults alongside renderer bindings on 'Reset all to defaults'", async () => {
    useKeybindingStore.setState({
      bindings: { ...getDefaultBindings(), "epic.new": "mod+alt+z" },
    });
    const set = vi.fn(() => Promise.resolve(makeStatus({})));
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({
        intent: { enabled: false, chord: "mod+alt+q" },
        status: "disabled",
        effectiveChord: "mod+alt+q",
      }),
    };

    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to defaults" }),
    );

    expect(useKeybindingStore.getState().bindings["epic.new"]).toBe(
      getDefaultBindings()["epic.new"],
    );
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith("summon", {
        enabled: true,
        chord: null,
      });
    });
  });

  // R5: a bare-key global registration would swallow ordinary typing
  // system-wide, so the global row rejects modifierless captures - but that
  // restriction is scoped to the global row only; a regular renderer action
  // must still accept a bare-key binding exactly as before.
  it("rejects a modifierless capture on the global row but still allows one on a regular renderer action", () => {
    const set = vi.fn(() => Promise.resolve(makeStatus({})));
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({}),
    };

    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Rebind the summon shortcut" }),
    );
    fireEvent.keyDown(window, { code: "KeyA", key: "a" });

    expect(set).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Global shortcuts need at least one modifier key (⌘, Ctrl, Shift, or Alt).",
      ),
    ).toBeTruthy();

    // Close the global row's still-open capture session before opening a
    // second one, so only one keydown listener is live for the next press.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recording new chord for the summon shortcut",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rebind epic.new" }));
    fireEvent.keyDown(window, { code: "KeyB", key: "b" });

    expect(useKeybindingStore.getState().bindings["epic.new"]).toBe("b");
  });

  // Decision 6: capturing a GLOBAL chord checks against every renderer
  // binding - a global shortcut swallows its chord system-wide before any
  // renderer listener sees it, so any overlap is a real conflict. This never
  // exercised the actual `externalReserved`/`checkConflict` wiring on the
  // global row's capture control before - only the enable-path (R1) and reset
  // (R4) did. Must fail if that wiring is removed.
  it("blocks the global row's capture when a renderer action already holds the candidate chord, and never calls bridge.set", () => {
    useKeybindingStore.setState({
      bindings: { ...getDefaultBindings(), "epic.new": "mod+alt+g" },
    });
    const set = vi.fn(() => Promise.resolve(makeStatus({})));
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({}),
    };

    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Rebind the summon shortcut" }),
    );
    fireEvent.keyDown(window, {
      code: "KeyG",
      key: "g",
      ctrlKey: true,
      altKey: true,
    });

    expect(set).not.toHaveBeenCalled();
    expect(
      screen.getByText('Already bound to "epic.new". Pick a different chord.'),
    ).toBeTruthy();
  });

  // Decision 6 (amended): the global chord is reserved by persisted INTENT,
  // not live OS status - a chord the user intends enabled stays reserved even
  // while the OS currently rejects it (it will register on a later launch).
  // This is the specific regression check for the F2 fix in
  // `chord-capture-input.tsx`: it must fail if the reservation goes back to
  // being gated on `status === "registered"` instead of `intent.enabled`.
  it("blocks a renderer capture against the global chord while intent is enabled even when the OS status is rejected (not registered)", () => {
    summonHotkeyMock.current = {
      bridge: makeBridge(() => Promise.resolve(makeStatus({}))),
      status: makeStatus({
        intent: { enabled: true, chord: "mod+alt+h" },
        effectiveChord: "mod+alt+h",
        status: "rejected",
      }),
    };

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rebind epic.new" }));
    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "h",
      ctrlKey: true,
      altKey: true,
    });

    expect(useKeybindingStore.getState().bindings["epic.new"]).toBe(
      getDefaultBindings()["epic.new"],
    );
    expect(
      screen.getByText(
        "Already used by Summon Traycer (global shortcut). Pick a different chord.",
      ),
    ).toBeTruthy();
  });

  // F1: `ChordCaptureCore` handles Backspace by calling `onClear()` directly
  // without checking what "clear" resolves to. The global row's clear
  // persists `chord: null`, which means the enabled DEFAULT chord becomes
  // live - so Backspace must run the same duplicate check against that
  // default chord (`clearResolvesTo`) before committing. Must fail if that
  // wiring is removed.
  it("blocks Backspace-to-default on the global row when a renderer action holds the default chord, then succeeds once that binding is gone", async () => {
    useKeybindingStore.setState({
      bindings: {
        ...getDefaultBindings(),
        "epic.new": GLOBAL_SHORTCUT_DEFAULT_CHORDS.summon,
      },
    });
    const set = vi.fn(() => Promise.resolve(makeStatus({})));
    summonHotkeyMock.current = {
      bridge: makeBridge(set),
      status: makeStatus({
        intent: { enabled: true, chord: "ctrl+alt+q" },
        effectiveChord: "ctrl+alt+q",
        status: "registered",
      }),
    };

    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Rebind the summon shortcut" }),
    );
    fireEvent.keyDown(window, { key: "Backspace" });

    expect(set).not.toHaveBeenCalled();
    expect(
      screen.getByText('Already bound to "epic.new". Pick a different chord.'),
    ).toBeTruthy();

    // Close the still-open (blocked) capture session, remove the colliding
    // renderer binding, then re-arm and retry - this time nothing reserves
    // the default chord, so clearing to it should succeed.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recording new chord for the summon shortcut",
      }),
    );
    act(() => {
      useKeybindingStore.setState({
        bindings: { ...getDefaultBindings(), "epic.new": null },
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Rebind the summon shortcut" }),
    );
    fireEvent.keyDown(window, { key: "Backspace" });

    await waitFor(() => {
      expect(set).toHaveBeenCalledWith("summon", {
        enabled: true,
        chord: null,
      });
    });
  });
});

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <KeybindingsSettingsPanel />
    </QueryClientProvider>,
  );
}
