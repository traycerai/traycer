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

  it("returns 'recovering' for a 'reaped' session before auto-recovery is exhausted, same as 'lost'", () => {
    // "Reaped" is definitive for THIS handle (the host confirmed via
    // TERMINAL_NOT_FOUND), but not for the durable terminal identity - the
    // host may already have restored it under the same logical id - so it
    // follows the same bounded recovery path as "lost" rather than an
    // immediate dead end.
    expect(
      resolveTerminalOverlayState({
        status: "reaped",
        connectionStatus: "closed",
        recoveryExhausted: false,
      }),
    ).toBe("recovering");
  });

  it("returns 'lost' (manual-retry prompt) once auto-recovery is exhausted for a 'reaped' session, same as 'lost'", () => {
    expect(
      resolveTerminalOverlayState({
        status: "reaped",
        connectionStatus: "closed",
        recoveryExhausted: true,
      }),
    ).toBe("lost");
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
