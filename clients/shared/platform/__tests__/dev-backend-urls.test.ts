import { describe, expect, it } from "vitest";
import {
  DEV_ALLOWED_BACKEND_ORIGINS_ENV,
  DEV_AUTHN_BASE_URL_ENV,
  DEV_CLOUD_UI_BASE_URL_ENV,
  allowedDevBackendOriginsFromEnv,
  devBackendUrlFromEnv,
} from "../dev-backend-urls";

// Fixture hosts only - real cloud origins must not appear here (OSS tree).
const BAKED = "https://baked.example";
const ALLOWED_ORIGINS = [
  "https://backend-a.example",
  "https://backend-b.example",
];

describe("dev-backend-urls", () => {
  it("pins the env var names (contract with the internal dev orchestrator)", () => {
    expect(DEV_AUTHN_BASE_URL_ENV).toBe("TRAYCER_DEV_AUTHN_BASE_URL");
    expect(DEV_CLOUD_UI_BASE_URL_ENV).toBe("TRAYCER_DEV_CLOUD_UI_BASE_URL");
    expect(DEV_ALLOWED_BACKEND_ORIGINS_ENV).toBe(
      "TRAYCER_DEV_ALLOWED_BACKEND_ORIGINS",
    );
  });

  it("returns the baked URL when the env var is unset or blank", () => {
    expect(devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {})).toBe(
      BAKED,
    );
    expect(
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
        [DEV_AUTHN_BASE_URL_ENV]: "   ",
      }),
    ).toBe(BAKED);
  });

  it.each(["staging", "production"])(
    "ignores the env var entirely for the %s baked environment",
    (environment) => {
      expect(
        devBackendUrlFromEnv(environment, DEV_AUTHN_BASE_URL_ENV, BAKED, {
          [DEV_AUTHN_BASE_URL_ENV]: "http://localhost:21001",
        }),
      ).toBe(BAKED);
      expect(
        devBackendUrlFromEnv(environment, DEV_AUTHN_BASE_URL_ENV, BAKED, {
          [DEV_AUTHN_BASE_URL_ENV]: "not a url",
        }),
      ).toBe(BAKED);
    },
  );

  it("accepts loopback http origins and normalizes to the origin", () => {
    expect(
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
        [DEV_AUTHN_BASE_URL_ENV]: "http://localhost:21001",
      }),
    ).toBe("http://localhost:21001");
    expect(
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
        [DEV_AUTHN_BASE_URL_ENV]: "  http://127.0.0.1:21001/  ",
      }),
    ).toBe("http://127.0.0.1:21001");
  });

  it("accepts https origins listed in TRAYCER_DEV_ALLOWED_BACKEND_ORIGINS", () => {
    const env = {
      [DEV_ALLOWED_BACKEND_ORIGINS_ENV]: JSON.stringify(ALLOWED_ORIGINS),
      [DEV_AUTHN_BASE_URL_ENV]: "https://backend-a.example",
    };
    expect(
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, env),
    ).toBe("https://backend-a.example");
    expect(allowedDevBackendOriginsFromEnv(env)).toEqual(
      new Set(ALLOWED_ORIGINS),
    );
  });

  it("rejects https origins that are not on the allowlist", () => {
    expect(() =>
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
        [DEV_ALLOWED_BACKEND_ORIGINS_ENV]: JSON.stringify(ALLOWED_ORIGINS),
        [DEV_AUTHN_BASE_URL_ENV]: "https://not-allowed.example",
      }),
    ).toThrow(/ALLOWED_BACKEND_ORIGINS|loopback/);
    expect(() =>
      devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
        [DEV_AUTHN_BASE_URL_ENV]: "https://backend-a.example",
      }),
    ).toThrow(/ALLOWED_BACKEND_ORIGINS|loopback/);
  });

  it("rejects anything that is not a bare allowed origin", () => {
    const reject = (value: string, message: RegExp) => {
      expect(() =>
        devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
          [DEV_AUTHN_BASE_URL_ENV]: value,
        }),
      ).toThrow(message);
    };
    reject("not a url", /valid URL/);
    reject("https://localhost:21001", /ALLOWED_BACKEND_ORIGINS|loopback|http/);
    reject("http://evil.example.com:80", /loopback|ALLOWED_BACKEND_ORIGINS/);
    reject("http://localhost", /include a port/);
    reject("http://user:pass@localhost:21001", /credentials/);
    reject("http://localhost:21001/path", /origin URL/);
    reject("http://localhost:21001/?q=1", /origin URL/);
  });
});
