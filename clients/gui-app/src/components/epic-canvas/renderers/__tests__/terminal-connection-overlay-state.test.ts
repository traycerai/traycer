import { describe, expect, it } from "vitest";
import { resolveTerminalOverlayState } from "../terminal-connection-overlay-state";

describe("resolveTerminalOverlayState", () => {
  it("returns null while healthy (running + open)", () => {
    expect(
      resolveTerminalOverlayState({
        status: "running",
        connectionStatus: "open",
        recoveryExhausted: false,
      }),
    ).toBeNull();
  });

  it("returns 'reconnecting' for a running session whose transport is mid-reconnect", () => {
    expect(
      resolveTerminalOverlayState({
        status: "running",
        connectionStatus: "reconnecting",
        recoveryExhausted: false,
      }),
    ).toBe("reconnecting");
  });

  it("returns 'recovering' for a recoverable 'lost' session before auto-recovery is exhausted", () => {
    expect(
      resolveTerminalOverlayState({
        status: "lost",
        connectionStatus: "closed",
        recoveryExhausted: false,
      }),
    ).toBe("recovering");
  });

  it("returns 'lost' (manual-retry prompt) once auto-recovery is exhausted", () => {
    expect(
      resolveTerminalOverlayState({
        status: "lost",
        connectionStatus: "closed",
        recoveryExhausted: true,
      }),
    ).toBe("lost");
  });

  it("returns 'sessionLost' for a definitively-reaped session regardless of the recovery budget (T13)", () => {
    expect(
      resolveTerminalOverlayState({
        status: "reaped",
        connectionStatus: "closed",
        recoveryExhausted: false,
      }),
    ).toBe("sessionLost");
    expect(
      resolveTerminalOverlayState({
        status: "reaped",
        connectionStatus: "closed",
        recoveryExhausted: true,
      }),
    ).toBe("sessionLost");
  });

  it("returns null while still creating, even mid-reconnect", () => {
    expect(
      resolveTerminalOverlayState({
        status: "creating",
        connectionStatus: "reconnecting",
        recoveryExhausted: false,
      }),
    ).toBeNull();
  });
});
