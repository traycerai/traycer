import { describe, expect, it } from "vitest";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../dev-desktop-slot";
import {
  credentialsWithEffectiveAuthnBaseUrl,
  effectiveAuthnBaseUrl,
  type StoredCredentials,
} from "../credentials";

const storedCreds: StoredCredentials = {
  token: "stored-token",
  refreshToken: "stored-refresh",
  authnBaseUrl: "http://localhost:21001",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

function withEnvironmentAndSlot(
  environment: string,
  slot: string | undefined,
  fn: () => void,
): void {
  const previousEnvironment = config.environment;
  const previousSlot = process.env[DEV_DESKTOP_SLOT_ENV];
  config.environment = environment;
  if (slot === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = slot;
  }
  try {
    fn();
  } finally {
    config.environment = previousEnvironment;
    if (previousSlot === undefined) {
      delete process.env[DEV_DESKTOP_SLOT_ENV];
    } else {
      process.env[DEV_DESKTOP_SLOT_ENV] = previousSlot;
    }
  }
}

describe("effectiveAuthnBaseUrl", () => {
  it("uses the current dev config URL when a dev-desktop run slot is active", () => {
    withEnvironmentAndSlot("dev", "my-slot", () => {
      expect(effectiveAuthnBaseUrl("http://localhost:21001")).toBe(
        config.authnBaseUrl,
      );
      expect(credentialsWithEffectiveAuthnBaseUrl(storedCreds)).toEqual({
        ...storedCreds,
        authnBaseUrl: config.authnBaseUrl,
      });
    });
  });

  it("keeps the serialized credentials URL in dev when no run slot is active", () => {
    // A plain from-source `dev` CLI invocation outside `make dev-desktop`
    // has no local backend stack; overriding here would validate tokens
    // against the wrong URL for every unrelated dev CLI call.
    withEnvironmentAndSlot("dev", undefined, () => {
      expect(effectiveAuthnBaseUrl("http://localhost:21001")).toBe(
        "http://localhost:21001",
      );
      expect(credentialsWithEffectiveAuthnBaseUrl(storedCreds)).toBe(
        storedCreds,
      );
    });
  });

  it("keeps the serialized credentials URL outside dev even with a slot set", () => {
    withEnvironmentAndSlot("production", "my-slot", () => {
      expect(effectiveAuthnBaseUrl("https://authn.example")).toBe(
        "https://authn.example",
      );
      expect(credentialsWithEffectiveAuthnBaseUrl(storedCreds)).toBe(
        storedCreds,
      );
    });
  });
});
