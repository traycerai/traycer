import { describe, expect, it, vi } from "vitest";
import { resolveBrowserCookieCryptoStateFromInputs } from "../browser-cookie-crypto";

vi.mock("electron", () => ({
  app: {
    commandLine: {
      hasSwitch: () => false,
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
}));

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("browser cookie crypto mode", () => {
  it("degrades when mock-keychain is active", () => {
    expect(
      resolveBrowserCookieCryptoStateFromInputs({
        platform: "darwin",
        encryptionAvailable: true,
        selectedStorageBackend: null,
        mockKeychainEnabled: true,
      }),
    ).toMatchObject({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "mock-keychain",
    });
  });

  it("degrades macOS keychain denial to ephemeral", () => {
    expect(
      resolveBrowserCookieCryptoStateFromInputs({
        platform: "darwin",
        encryptionAvailable: false,
        selectedStorageBackend: null,
        mockKeychainEnabled: false,
      }),
    ).toMatchObject({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "keychain-denied",
    });
  });

  it("persists Linux basic_text as the accepted basic mode", () => {
    expect(
      resolveBrowserCookieCryptoStateFromInputs({
        platform: "linux",
        encryptionAvailable: true,
        selectedStorageBackend: "basic_text",
        mockKeychainEnabled: false,
      }),
    ).toMatchObject({
      mode: "basic",
      persistence: "persistent",
      reason: "linux-basic-text",
    });
  });

  it("persists OS-backed encryption as real mode", () => {
    expect(
      resolveBrowserCookieCryptoStateFromInputs({
        platform: "win32",
        encryptionAvailable: true,
        selectedStorageBackend: null,
        mockKeychainEnabled: false,
      }),
    ).toMatchObject({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    });
  });
});
