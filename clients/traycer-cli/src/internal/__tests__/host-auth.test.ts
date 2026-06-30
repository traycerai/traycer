import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliBearerStore, resolveHostAuth } from "../host-auth";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../../store/credentials";

vi.mock("../../store/credentials", () => ({
  readCredentials: vi.fn(),
  writeCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveHostAuth", () => {
  it("returns token, authnBaseUrl, and userId from the stored credentials", async () => {
    readMock.mockResolvedValue(storedCreds);
    expect(await resolveHostAuth()).toEqual({
      token: "stored-token",
      authnBaseUrl: "https://authn.test",
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
});
