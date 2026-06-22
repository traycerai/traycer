import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn(),
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

describe("parseAuthCallback", () => {
  it("returns { code } for a well-formed callback with a non-empty code parameter", async () => {
    const mod = await import("../deep-link");
    const result = mod.parseAuthCallback(
      "traycer-dev://auth/callback?code=abc123",
    );
    expect(result).toEqual({ code: "abc123" });
  });

  it("returns { error } when the callback carries an explicit error parameter", async () => {
    const mod = await import("../deep-link");
    const result = mod.parseAuthCallback(
      "traycer-dev://auth/callback?error=access_denied",
    );
    expect(result).toEqual({ error: "access_denied" });
  });

  it("returns { error } when the code is missing or empty", async () => {
    const mod = await import("../deep-link");
    expect(mod.parseAuthCallback("traycer-dev://auth/callback")).toEqual({
      error: "missing code in auth callback",
    });
    expect(mod.parseAuthCallback("traycer-dev://auth/callback?code=")).toEqual({
      error: "missing code in auth callback",
    });
  });

  it("returns null for non-auth traycer deep links", async () => {
    const mod = await import("../deep-link");
    expect(mod.parseAuthCallback("traycer-dev://session/xyz")).toBeNull();
  });

  it("returns null for non-traycer URIs", async () => {
    const mod = await import("../deep-link");
    expect(
      mod.parseAuthCallback(
        "https://example.com/auth/callback?traycer-tokens=abc",
      ),
    ).toBeNull();
  });

  it("tolerates trailing slashes in the callback path", async () => {
    const mod = await import("../deep-link");
    const result = mod.parseAuthCallback(
      "traycer-dev://auth/callback/?code=xyz",
    );
    expect(result).toEqual({ code: "xyz" });
  });
});
