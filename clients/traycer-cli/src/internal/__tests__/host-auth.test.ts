import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHostAuth } from "../host-auth";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import { readCredentials } from "../../store/credentials";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Every host-auth branch logs. Avoid writing those test diagnostics to the
// live per-slot CLI log while preserving the credentials boundary mock below.
vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
}));

vi.mock("../../store/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials")>();
  return {
    ...actual,
    readCredentials: vi.fn(),
  };
});

const readMock = vi.mocked(readCredentials);

const storedCreds = {
  token: "stored-token",
  refreshToken: "stored-refresh",
  authnBaseUrl: "https://authn.test",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "a@b.c", name: "A" },
};

const ORIGINAL_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];

beforeEach(() => {
  vi.clearAllMocks();
  process.env[DEV_DESKTOP_SLOT_ENV] = "test-slot";
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_SLOT === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = ORIGINAL_SLOT;
  }
});

describe("resolveHostAuth", () => {
  it("returns token, effective authnBaseUrl, and userId from the stored credentials during a dev-desktop run", async () => {
    readMock.mockResolvedValue(storedCreds);
    expect(await resolveHostAuth()).toEqual({
      token: "stored-token",
      authnBaseUrl: config.authnBaseUrl,
      userId: "u1",
    });
  });

  it("keeps the serialized authnBaseUrl when no dev-desktop run slot is active", async () => {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
    readMock.mockResolvedValue(storedCreds);
    expect(await resolveHostAuth()).toEqual({
      token: "stored-token",
      authnBaseUrl: storedCreds.authnBaseUrl,
      userId: "u1",
    });
  });

  it("returns null when no credentials are stored", async () => {
    readMock.mockResolvedValue(null);
    expect(await resolveHostAuth()).toBeNull();
  });

  it("returns null when the stored token is empty", async () => {
    readMock.mockResolvedValue({ ...storedCreds, token: "" });
    expect(await resolveHostAuth()).toBeNull();
  });

  it("regression: returns null instead of throwing when DEV_DESKTOP_SLOT sanitizes to an unusable slot", async () => {
    process.env[DEV_DESKTOP_SLOT_ENV] = "!!!";
    readMock.mockResolvedValue(storedCreds);
    expect(await resolveHostAuth()).toBeNull();
  });
});
