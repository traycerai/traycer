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

describe("configureUserAgent", () => {
  beforeEach(() => {
    electronState.app.userAgentFallback = "";
    electronState.defaultSessionUserAgent = "";
  });

  it("sets a branded UA on the default session and a clean UA as the fallback", async () => {
    const { configureUserAgent } = await import("../network");
    configureUserAgent();

    expect(electronState.defaultSessionUserAgent).toBe(
      "TraycerDesktop/1.2.3 Electron/30.0.0 Chrome/125.0.6422.0",
    );

    const fallback = electronState.app.userAgentFallback;
    expect(fallback).toMatch(/Chrome\/.+Safari\/537\.36/);
    expect(fallback).not.toMatch(/Electron/);
    expect(fallback).not.toMatch(/Traycer/);
  });
});
