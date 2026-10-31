/**
 * With the unreleased features off, Talk is bound to nothing: no default
 * chord, and none from a profile an enabled build saved. Its keys reach the
 * page as they did before the voice layer existed, no browser tile forwards
 * them, and no rebind conflicts with them; the stored chord is kept for a
 * build that has Talk again. The installed mobile app matches the other
 * desktop-only actions as it did before Talk, so their default chords stay
 * reserved there.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";
import { reservedBrowserChordsFor } from "@/lib/browser-view/reserved-chords-registration";
import {
  effectiveBinding,
  getDefaultBindings,
} from "@/lib/keybindings/actions";
import { findConflict } from "@/lib/keybindings/conflicts";
import { findActionMatchForChord } from "@/lib/keybindings/dispatch";
import { setMobileApp } from "@/lib/mobile-app";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

function renderProvider(): void {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(<KeybindingProvider router={router}>{null}</KeybindingProvider>);
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/** Loads `talkChord` as an enabled build would have saved it, through the store's own hydration. */
async function hydrateSavedTalk(talkChord: string): Promise<void> {
  window.localStorage.setItem(
    persistKey(STORE_KEYS.keybinding),
    JSON.stringify({
      state: {
        bindings: { ...getDefaultBindings(), "voice.talk.toggle": talkChord },
      },
      version: 1,
    }),
  );
  await useKeybindingStore.persist.rehydrate();
}

function forwardedTokens(): ReadonlyArray<string> {
  return reservedBrowserChordsFor(useKeybindingStore.getState().bindings, {
    landingSurfaceActive: false,
  }).map((row) => row.token);
}

beforeEach(() => {
  window.localStorage.clear();
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Talk with the voice layer unreleased", () => {
  it("has no default chord, so its keys are not reserved", () => {
    renderProvider();
    expect(useKeybindingStore.getState().bindings["voice.talk.toggle"]).toBe(
      null,
    );
    const event = press({
      code: "KeyT",
      key: "T",
      altKey: true,
      shiftKey: true,
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it("takes no key a saved profile bound to it, default or custom, from the app or a browser tile", async () => {
    for (const saved of [
      {
        chord: "alt+shift+t",
        init: { code: "KeyT", key: "T", altKey: true, shiftKey: true },
      },
      {
        chord: "mod+shift+y",
        init: { code: "KeyY", key: "Y", ctrlKey: true, shiftKey: true },
      },
    ]) {
      await hydrateSavedTalk(saved.chord);
      const stored =
        useKeybindingStore.getState().bindings["voice.talk.toggle"];
      // Kept for a build that has Talk again.
      expect(stored).not.toBeNull();
      if (stored === null) return;

      renderProvider();
      expect(press(saved.init).defaultPrevented).toBe(false);
      expect(forwardedTokens()).not.toContain(stored);
      expect(
        findConflict(
          useKeybindingStore.getState().bindings,
          "tab.reopen",
          stored,
          [],
        ),
      ).toBeNull();
      cleanup();
    }
  });
});

describe("the vertical-tabs collapse chord in the installed mobile app", () => {
  it("is still reserved there: its default chord matches and the key is swallowed", () => {
    const bindings = useKeybindingStore.getState().bindings;
    const chord = bindings["app.tabs.vertical.collapse"];
    expect(chord).toBe("shift+alt+s");
    if (chord === null) return;
    setMobileApp(true);
    try {
      expect(effectiveBinding(bindings, "app.tabs.vertical.collapse")).toBe(
        chord,
      );
      expect(findActionMatchForChord(chord)?.actionId).toBe(
        "app.tabs.vertical.collapse",
      );
      renderProvider();
      const event = press({
        code: "KeyS",
        key: "S",
        altKey: true,
        shiftKey: true,
      });
      expect(event.defaultPrevented).toBe(true);
    } finally {
      setMobileApp(false);
    }
  });
});
