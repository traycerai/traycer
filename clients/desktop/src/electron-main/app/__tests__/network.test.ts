import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  app: {
    getVersion: (): string => "1.2.3",
    userAgentFallback: "",
  },
  defaultSessionUserAgent: "",
}));

vi.mock("electron", () => ({
  app: electronState.app,
  session: {
    defaultSession: {
      setUserAgent: (ua: string): void => {
        electronState.defaultSessionUserAgent = ua;
      },
      preconnect: vi.fn(),
    },
  },
}));

vi.mock("../logger", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

Object.defineProperty(process.versions, "electron", {
  value: "30.0.0",
  configurable: true,
});
Object.defineProperty(process.versions, "chrome", {
  value: "125.0.6422.0",
  configurable: true,
});

const ELECTRON_DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Traycer/1.2.3 Chrome/125.0.6422.0 Electron/30.0.0 Safari/537.36";

describe("configureUserAgent", () => {
  beforeEach(() => {
    electronState.app.userAgentFallback = ELECTRON_DEFAULT_UA;
    electronState.defaultSessionUserAgent = "";
  });

  it("sets a branded UA on the default session and drops only the Electron token from the guest fallback", async () => {
    const { configureUserAgent } = await import("../network");
    configureUserAgent();

    expect(electronState.defaultSessionUserAgent).toBe(
      "TraycerDesktop/1.2.3 Electron/30.0.0 Chrome/125.0.6422.0",
    );

    // Guests keep the product token and the rest of the default UA (a bare
    // Chrome UA is what Google sign-in rejected). Only `Electron/<ver>` goes:
    // GoHighLevel's login sniffs it.
    expect(electronState.app.userAgentFallback).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Traycer/1.2.3 Chrome/125.0.6422.0 Safari/537.36",
    );
  });
});
