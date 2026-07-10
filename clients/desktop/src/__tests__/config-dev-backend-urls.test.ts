import { afterEach, describe, expect, it, vi } from "vitest";

// `config.ts` resolves the dev-gated backend URL overrides once, at module
// init - so each case stubs the env first and imports the module fresh.
// The non-dev ("shipped builds ignore the env") side of the gate lives in
// the shared helper's own tests; the source tree always bakes "dev".

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("desktop config dev backend URL overrides", () => {
  it("keeps the committed production URLs when the env vars are unset", async () => {
    const { config } = await import("../config");
    expect(config.authnBaseUrl).toBe("https://authn.traycer.ai");
    expect(config.cloudUiBaseUrl).toBe("https://platform.traycer.ai");
  });

  it("honors loopback overrides and keeps everything else baked", async () => {
    vi.stubEnv("TRAYCER_DEV_AUTHN_BASE_URL", "http://localhost:21001");
    vi.stubEnv("TRAYCER_DEV_CLOUD_UI_BASE_URL", "http://localhost:21003");
    const { config, DESKTOP_SIGN_IN_BASE_URL, isDevBuild } =
      await import("../config");
    expect(config.authnBaseUrl).toBe("http://localhost:21001");
    expect(config.cloudUiBaseUrl).toBe("http://localhost:21003");
    // Derived consts must see the resolved values / untouched fields.
    expect(DESKTOP_SIGN_IN_BASE_URL).toBe("http://localhost:21003");
    expect(config.environment).toBe("dev");
    expect(isDevBuild).toBe(true);
  });

  it("throws at module init on a non-loopback override", async () => {
    vi.stubEnv("TRAYCER_DEV_AUTHN_BASE_URL", "http://evil.example.com:80");
    await expect(import("../config")).rejects.toThrow(/loopback/);
  });
});
