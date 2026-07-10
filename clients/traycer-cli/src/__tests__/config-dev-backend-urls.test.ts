import { afterEach, describe, expect, it, vi } from "vitest";

// `config.ts` resolves the dev-gated backend URL overrides once, at module
// init - so each case stubs the env first and imports the module fresh.
// The non-dev ("shipped builds ignore the env") side of the gate lives in
// the shared helper's own tests; the source tree always bakes "dev".

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CLI config dev backend URL overrides", () => {
  it("keeps the committed production URLs when the env vars are unset", async () => {
    const { config } = await import("../config");
    expect(config.authnBaseUrl).toBe("https://authn.traycer.ai");
    expect(config.cloudUiBaseUrl).toBe("https://platform.traycer.ai");
  });

  it("honors loopback overrides and keeps the trust root baked", async () => {
    vi.stubEnv("TRAYCER_DEV_AUTHN_BASE_URL", "http://localhost:21001");
    vi.stubEnv("TRAYCER_DEV_CLOUD_UI_BASE_URL", "http://localhost:21003");
    const { config, hostRegistryUrl } = await import("../config");
    expect(config.authnBaseUrl).toBe("http://localhost:21001");
    expect(config.cloudUiBaseUrl).toBe("http://localhost:21003");
    // The override must not be able to touch the registry or trust root.
    expect(config.environment).toBe("dev");
    expect(config.releaseRepo).toBe("traycerai/traycer");
    expect(config.hostTrustedPubkeys).toHaveLength(1);
    expect(hostRegistryUrl).toContain("github.com/traycerai/traycer");
  });

  it("throws at module init on a non-loopback override", async () => {
    vi.stubEnv("TRAYCER_DEV_AUTHN_BASE_URL", "http://evil.example.com:80");
    await expect(import("../config")).rejects.toThrow(/loopback/);
  });
});
