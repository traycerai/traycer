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
    mod.registerDeepLinkHandling(
      () => undefined,
      () => undefined,
    );
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalled();
  });

  it("fires the payload-free return signal on an auth/callback deep link", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    fireOpenUrl("traycer-dev://auth/callback");

    expect(handler).toHaveBeenCalledTimes(1);
    // The handler takes no arguments - it is a pure nudge.
    expect(handler).toHaveBeenNthCalledWith(1);
  });

  it("tolerates a stray legacy ?code= by ignoring it (still a payload-free signal)", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    fireOpenUrl("traycer-dev://auth/callback?code=legacy-code&error=ignored");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenNthCalledWith(1);
  });

  it("tolerates a trailing slash in the callback path", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    fireOpenUrl("traycer-dev://auth/callback/");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores non-auth traycer deep links", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    fireOpenUrl("traycer-dev://session/xyz");

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores non-traycer URIs", async () => {
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    fireOpenUrl("https://example.com/auth/callback?code=abc");

    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * Multi-run dev: each slot registers its own suffixed scheme so the OS never
 * routes another run's auth callback here. Mirrors the renderer's redirect-URI
 * derivation in `renderer-shell/sign-in-url.ts` - the two must agree.
 */
describe("registerDeepLinkHandling under a dev-desktop slot", () => {
  beforeEach(() => {
    appListeners.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("registers the slot-suffixed scheme and matches only its own callbacks", async () => {
    vi.stubEnv("DEV_DESKTOP_SLOT", "My Worktree!!");
    const electron = await import("electron");
    const mod = await import("../deep-link");
    const handler = vi.fn();
    mod.registerDeepLinkHandling(handler, () => undefined);

    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      "traycer-dev-my-worktree",
    );

    fireOpenUrl("traycer-dev-my-worktree://auth/callback");
    expect(handler).toHaveBeenCalledTimes(1);

    // A sibling run's (or the bare dev) callback is not ours.
    fireOpenUrl("traycer-dev://auth/callback");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("traycer://open/epic/<epicId>/chat/<chatId> deep links", () => {
  const EPIC = "6b1c3f0e-2d4a-4e8b-9c7d-1a2b3c4d5e6f";
  const CHAT = "0f1e2d3c-4b5a-4968-8776-655443322110";

  beforeEach(() => {
    appListeners.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("parses epic and chat ids and ignores an optional focus hint", async () => {
    const mod = await import("../deep-link");
    expect(
      mod.parseOpenChatUri(`traycer-dev://open/epic/${EPIC}/chat/${CHAT}`),
    ).toEqual({ epicId: EPIC, chatId: CHAT });
    expect(
      mod.parseOpenChatUri(
        `traycer-dev://open/epic/${EPIC}/chat/${CHAT}/?focus=composer`,
      ),
    ).toEqual({ epicId: EPIC, chatId: CHAT });
  });

  it("rejects other schemes, other paths and ids outside the opaque alphabet", async () => {
    const mod = await import("../deep-link");
    for (const uri of [
      `https://open/epic/${EPIC}/chat/${CHAT}`,
      `traycer-dev://open/epic/${EPIC}`,
      `traycer-dev://open/epic/${EPIC}/chat/${CHAT}/extra`,
      `traycer-dev://open/epic/..%2F..%2Fetc/chat/${CHAT}`,
      `traycer-dev://open/epic/${EPIC}/chat/a.b`,
      `traycer-dev://open/epic/${"x".repeat(129)}/chat/${CHAT}`,
      "traycer-dev://auth/callback",
    ]) {
      expect(mod.parseOpenChatUri(uri)).toBeNull();
    }
  });

  it("routes an open-chat link only to the open-chat handler and an auth callback only to the auth handler", async () => {
    const mod = await import("../deep-link");
    const auth = vi.fn();
    const openChat = vi.fn();
    mod.registerDeepLinkHandling(auth, openChat);

    fireOpenUrl(`traycer-dev://open/epic/${EPIC}/chat/${CHAT}`);
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith({ epicId: EPIC, chatId: CHAT });
    expect(auth).not.toHaveBeenCalled();

    fireOpenUrl("traycer-dev://auth/callback");
    expect(auth).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledTimes(1);
  });
});
