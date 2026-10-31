/**
 * With the unreleased features off, Talk's shortcut has no default chord:
 * Alt+Shift+T reaches the page as it did before the voice layer existed.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

afterEach(() => {
  cleanup();
});

it("leaves Talk unbound, so its chord is not reserved", () => {
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
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
  const event = new KeyboardEvent("keydown", {
    code: "KeyT",
    key: "T",
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(useKeybindingStore.getState().bindings["voice.talk.toggle"]).toBe(
    null,
  );
  expect(event.defaultPrevented).toBe(false);
});
