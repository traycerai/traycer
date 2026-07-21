import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliBearerStore, resolveHostAuth } from "../host-auth";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../../store/credentials";

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
    writeCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  };
});

const readMock = vi.mocked(readCredentials);
const writeMock = vi.mocked(writeCredentials);
const deleteMock = vi.mocked(deleteCredentials);

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

describe("cliBearerStore", () => {
  it("read returns the stored token, or null when absent", async () => {
    readMock.mockResolvedValueOnce(storedCreds);
    expect(await cliBearerStore.read()).toEqual({
      token: "stored-token",
      refreshToken: "stored-refresh",
      userId: "u1",
    });
    readMock.mockResolvedValueOnce(null);
    expect(await cliBearerStore.read()).toBeNull();
  });

  it("write merges the rotated token, preserving the advisory user + authnBaseUrl", async () => {
    readMock.mockResolvedValue(storedCreds);
    await cliBearerStore.write({
      token: "rotated",
      refreshToken: "rotated-refresh",
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0];
    expect(written.token).toBe("rotated");
    expect(written.user).toEqual(storedCreds.user);
    expect(written.authnBaseUrl).toBe(storedCreds.authnBaseUrl);
    expect(written.savedAt).not.toBe(storedCreds.savedAt);
  });

  it("write is a no-op when the credentials file vanished mid-flight", async () => {
    readMock.mockResolvedValue(null);
    await cliBearerStore.write({
      token: "rotated",
      refreshToken: "rotated-refresh",
    });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("clear deletes the credentials file", async () => {
    deleteMock.mockResolvedValue(true);
    await cliBearerStore.clear();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it("regression: still deletes credentials when DEV_DESKTOP_SLOT sanitizes to an unusable slot", async () => {
    // `devDesktopSlotForEnvironment` throws when DEV_DESKTOP_SLOT is set but
    // sanitizes to empty - and `createCliLogger` hits that same throw via
    // `cliLogPath`. Before the fix, both ran before deleting credentials, so
    // this throw skipped the delete entirely - the one case a caller most
    // wants `clear()` to succeed on: it never received a usable bearer to
    // sign out from in the first place.
    process.env[DEV_DESKTOP_SLOT_ENV] = "!!!";
    deleteMock.mockResolvedValue(true);
    await expect(cliBearerStore.clear()).rejects.toThrow(
      "must contain a usable slot name",
    );
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
