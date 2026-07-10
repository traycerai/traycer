import { describe, expect, it } from "vitest";
import {
  DEV_AUTHN_BASE_URL_ENV,
  DEV_CLOUD_UI_BASE_URL_ENV,
  devBackendUrlFromEnv,
} from "../dev-backend-urls";

const BAKED = "https://authn.traycer.ai";

describe("dev-backend-urls", () => {
  it("pins the env var names (contract with the internal dev orchestrator)", () => {
    expect(DEV_AUTHN_BASE_URL_ENV).toBe("TRAYCER_DEV_AUTHN_BASE_URL");
    expect(DEV_CLOUD_UI_BASE_URL_ENV).toBe("TRAYCER_DEV_CLOUD_UI_BASE_URL");
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

  // The gate that keeps shipped builds immune to a hostile/stray runtime
  // environment: staging/production bake a non-"dev" literal, so the lookup
  // never happens - not even to validate.
  it.each(["staging", "production"])(
    "ignores the env var entirely for the %s baked environment",
    (environment) => {
      expect(
        devBackendUrlFromEnv(environment, DEV_AUTHN_BASE_URL_ENV, BAKED, {
          [DEV_AUTHN_BASE_URL_ENV]: "http://localhost:21001",
        }),
      ).toBe(BAKED);
      // Even a malformed value must not throw outside dev.
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

  it("rejects anything that is not a bare loopback http origin", () => {
    const reject = (value: string, message: RegExp) => {
      expect(() =>
        devBackendUrlFromEnv("dev", DEV_AUTHN_BASE_URL_ENV, BAKED, {
          [DEV_AUTHN_BASE_URL_ENV]: value,
        }),
      ).toThrow(message);
    };
    reject("not a url", /valid URL/);
    reject("https://localhost:21001", /must use http/);
    reject("http://evil.example.com:80", /loopback/);
    reject("http://localhost", /include a port/);
    reject("http://user:pass@localhost:21001", /credentials/);
    reject("http://localhost:21001/path", /origin URL/);
    reject("http://localhost:21001/?q=1", /origin URL/);
  });
});
