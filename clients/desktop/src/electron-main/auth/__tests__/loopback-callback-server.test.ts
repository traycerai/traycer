import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthCallbackParseResult } from "../deep-link";
import type { LoopbackCallbackServer } from "../loopback-callback-server";

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

let active: LoopbackCallbackServer | null = null;

afterEach(() => {
  active?.close();
  active = null;
});

async function start(
  onCallback: (result: AuthCallbackParseResult) => void,
): Promise<LoopbackCallbackServer> {
  const mod = await import("../loopback-callback-server");
  active = await mod.startLoopbackCallbackServer(onCallback);
  return active;
}

describe("startLoopbackCallbackServer", () => {
  it("binds a 127.0.0.1 loopback redirect_uri ending in /auth/callback", async () => {
    const server = await start(() => {});
    expect(server.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
  });

  it("parses the code from the callback query and delivers it, then 200s", async () => {
    const received: AuthCallbackParseResult[] = [];
    const server = await start((result) => received.push(result));

    const res = await fetch(`${server.redirectUri}?code=auth-code-abc`);

    expect(res.status).toBe(200);
    expect(received).toEqual([{ code: "auth-code-abc" }]);
  });

  it("delivers an error result and 400s when the code is absent", async () => {
    const received: AuthCallbackParseResult[] = [];
    const server = await start((result) => received.push(result));

    const res = await fetch(`${server.redirectUri}?error=denied`);

    expect(res.status).toBe(400);
    expect(received).toEqual([{ error: "denied" }]);
  });

  it("404s a non-callback path without invoking the handler", async () => {
    const received: AuthCallbackParseResult[] = [];
    const server = await start((result) => received.push(result));

    const base = server.redirectUri.replace("/auth/callback", "");
    const res = await fetch(`${base}/favicon.ico`);

    expect(res.status).toBe(404);
    expect(received).toEqual([]);
  });
});
