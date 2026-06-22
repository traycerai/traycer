import { afterEach, describe, expect, it } from "vitest";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";

describe("setup-terminal-registration-store", () => {
  // Demonstrates the reset affordance: module-level store state would otherwise
  // leak across cases, so every case starts from a clean registration set.
  afterEach(() => {
    useSetupTerminalRegistrationStore.getState().reset();
  });

  it("registers a key exactly once: true first, false thereafter", () => {
    const { registerOnce } = useSetupTerminalRegistrationStore.getState();
    expect(registerOnce("view-1:setup-a")).toBe(true);
    expect(registerOnce("view-1:setup-a")).toBe(false);
    expect(registerOnce("view-1:setup-a")).toBe(false);
  });

  it("scopes registration per view, so the same setup session in another view opens its own tab", () => {
    const { registerOnce } = useSetupTerminalRegistrationStore.getState();
    // Same setupTerminalSessionId, two different view tabs -> each registers once.
    expect(registerOnce("view-1:setup-a")).toBe(true);
    expect(registerOnce("view-2:setup-a")).toBe(true);
    // ...and neither re-registers on a later binding update / remount.
    expect(registerOnce("view-1:setup-a")).toBe(false);
    expect(registerOnce("view-2:setup-a")).toBe(false);
  });

  it("reset() clears registrations so a later call registers again", () => {
    expect(
      useSetupTerminalRegistrationStore
        .getState()
        .registerOnce("view-1:setup-a"),
    ).toBe(true);
    useSetupTerminalRegistrationStore.getState().reset();
    expect(
      useSetupTerminalRegistrationStore
        .getState()
        .registerOnce("view-1:setup-a"),
    ).toBe(true);
  });
});
