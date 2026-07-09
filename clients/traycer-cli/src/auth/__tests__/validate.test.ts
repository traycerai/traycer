import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAuthTokenViaHttp } from "../../../../shared/auth/auth-validation";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import { readCredentials, writeCredentials } from "../../store/credentials";
import { validateStoredCredentials } from "../validate";

vi.mock("../../../../shared/auth/auth-validation", () => ({
  validateAuthTokenViaHttp: vi.fn(),
}));

vi.mock("../../store/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials")>();
  return {
    ...actual,
    readCredentials: vi.fn(),
    writeCredentials: vi.fn(),
  };
});

const validateMock = vi.mocked(validateAuthTokenViaHttp);
const readMock = vi.mocked(readCredentials);
const writeMock = vi.mocked(writeCredentials);
const ORIGINAL_ENVIRONMENT = config.environment;
const ORIGINAL_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];

const storedCreds = {
  token: "stored-token",
  refreshToken: "stored-refresh",
  authnBaseUrl: "http://localhost:21001",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "old@traycer.ai", name: "Old" },
};

const validProfile = {
  kind: "valid" as const,
  profile: { userId: "u1", email: "ada@traycer.ai", userName: "Ada" },
};

beforeEach(() => {
  vi.clearAllMocks();
  config.environment = "dev";
  process.env[DEV_DESKTOP_SLOT_ENV] = "test-slot";
  readMock.mockResolvedValue(storedCreds);
  validateMock.mockResolvedValue(validProfile);
});

afterEach(() => {
  config.environment = ORIGINAL_ENVIRONMENT;
  if (ORIGINAL_SLOT === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = ORIGINAL_SLOT;
  }
});

describe("validateStoredCredentials", () => {
  it("validates dev-desktop run credentials against the current config authn URL", async () => {
    const outcome = await validateStoredCredentials();

    expect(validateMock).toHaveBeenCalledWith(
      config.authnBaseUrl,
      "stored-token",
      "stored-refresh",
    );
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: {
        authnBaseUrl: config.authnBaseUrl,
        user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      },
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0].authnBaseUrl).toBe(
      "http://localhost:21001",
    );
  });

  it("keeps dev validation on the serialized credentials URL when no run slot is active", async () => {
    delete process.env[DEV_DESKTOP_SLOT_ENV];

    await validateStoredCredentials();

    expect(validateMock).toHaveBeenCalledWith(
      "http://localhost:21001",
      "stored-token",
      "stored-refresh",
    );
  });

  it("keeps production validation on the serialized credentials URL", async () => {
    config.environment = "production";

    await validateStoredCredentials();

    expect(validateMock).toHaveBeenCalledWith(
      "http://localhost:21001",
      "stored-token",
      "stored-refresh",
    );
  });
});
