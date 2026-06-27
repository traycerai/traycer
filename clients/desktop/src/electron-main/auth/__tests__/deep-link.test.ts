import { beforeEach, describe, expect, it, vi } from "vitest";

const { appListeners } = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  app: {
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(event, listener);
    }),
    whenReady: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function fireOpenUrl(url: string): void {
  const openUrl = appListeners.get("open-url");
  openUrl?.({ preventDefault: () => undefined }, url);
}

describe("registerDeepLinkHandling (demoted return-signal handler)", () => {
  beforeEach(() => {
    appListeners.clear();
    vi.clearAllMocks();
  });

  it("registers the traycer:// protocol scheme", async () => {
    const electron = await import("electron");
    const mod = await import("../deep-link");
    mod.registerDeepLinkHandling(() => undefined);
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalled();
  });

  it("fires the payload-free return signal on an auth/callback deep link", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler);

    fireOpenUrl("traycer-dev://auth/callback");

    expect(handler).toHaveBeenCalledTimes(1);
    // The handler takes no arguments - it is a pure nudge.
    expect(handler).toHaveBeenNthCalledWith(1);
  });

  it("tolerates a stray legacy ?code= by ignoring it (still a payload-free signal)", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler);

    fireOpenUrl("traycer-dev://auth/callback?code=legacy-code&error=ignored");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenNthCalledWith(1);
  });

  it("tolerates a trailing slash in the callback path", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler);

    fireOpenUrl("traycer-dev://auth/callback/");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores non-auth traycer deep links", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler);

    fireOpenUrl("traycer-dev://session/xyz");

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores non-traycer URIs", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler);

    fireOpenUrl("https://example.com/auth/callback?code=abc");

    expect(handler).not.toHaveBeenCalled();
  });
});
