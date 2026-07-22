import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { validateAuthTokenIdentityAccessOnly } from "../../../../shared/auth/auth-validation";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import { readCredentials } from "../../store/credentials";
import { validateStoredCredentials } from "../validate";

// Access-only validation (§3/§7): the spend/write goes through the locked store.
// Keep the real (pure) identity projection, stub the network probe, and inject a
// fake store through the store-facing helpers `validate` imports directly. Mocking
// `createCliCredentialsStore` alone would NOT work: `runWithCliStore` calls it
// intra-module, so we mock `runWithCliStore` / `withCommitRetry` instead and steer
// `updateProfile` / `rotate` per-test.
const { fakeStore, updateProfileMock, rotateMock } = vi.hoisted(() => {
  const updateProfileMock = vi.fn();
  const rotateMock = vi.fn();
  return {
    updateProfileMock,
    rotateMock,
    fakeStore: {
      read: vi.fn(),
      rotate: rotateMock,
      signIn: vi.fn(),
      signOut: vi.fn(),
      updateProfile: updateProfileMock,
      guardedSignIn: vi.fn(),
      migrateFirstWrite: vi.fn(),
      hasPendingContinuation: () => false,
      dispose: vi.fn(),
    },
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return { ...actual, validateAuthTokenIdentityAccessOnly: vi.fn() };
});

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// `validateStoredCredentials` emits diagnostic logs. Keep this unit test
// hermetic rather than appending those diagnostics to the live CLI log.
vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
}));

vi.mock("../../store/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials")>();
  return { ...actual, readCredentials: vi.fn() };
});

vi.mock("../../store/credentials-store", () => ({
  createCliCredentialsStore: () => fakeStore,
  runWithCliStore: (fn: (store: unknown) => unknown) => fn(fakeStore),
  withCommitRetry: (op: () => unknown) => op(),
}));

const identityMock = vi.mocked(validateAuthTokenIdentityAccessOnly);
const readMock = vi.mocked(readCredentials);

const ORIGINAL_ENVIRONMENT = config.environment;
const ORIGINAL_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];

const storedCreds = {
  token: "stored-token",
  refreshToken: "stored-refresh",
  authnBaseUrl: "http://localhost:21001",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "old@traycer.ai", name: "Old" },
};

// Build an AuthenticatedUser with a specific identity, keeping every other
// required field from the canonical fixture.
function userWith(id: string, email: string, name: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id, email, name } };
}

const unchangedUser = userWith("u1", "old@traycer.ai", "Old");
const changedUser = userWith("u1", "ada@traycer.ai", "Ada");

beforeEach(() => {
  vi.clearAllMocks();
  config.environment = "dev";
  process.env[DEV_DESKTOP_SLOT_ENV] = "test-slot";
  readMock.mockResolvedValue(storedCreds);
  // Default: access token valid, profile unchanged (no store write).
  identityMock.mockResolvedValue({ kind: "valid", user: unchangedUser });
  updateProfileMock.mockResolvedValue({
    outcome: "applied",
    credentials: null,
  });
  rotateMock.mockResolvedValue({ outcome: "applied", credentials: null });
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
  it("validates dev-desktop run credentials against the current config authn URL and merges a drifted profile", async () => {
    identityMock.mockResolvedValue({ kind: "valid", user: changedUser });
    updateProfileMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        ...storedCreds,
        user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      },
    });

    const outcome = await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      config.authnBaseUrl,
      "stored-token",
    );
    expect(updateProfileMock).toHaveBeenCalledWith({
      expectedToken: "stored-token",
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      signal: null,
    });
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: {
        authnBaseUrl: config.authnBaseUrl,
        user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      },
    });
  });

  it("keeps dev validation on the serialized credentials URL when no run slot is active", async () => {
    delete process.env[DEV_DESKTOP_SLOT_ENV];

    await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      "http://localhost:21001",
      "stored-token",
    );
  });

  it("keeps production validation on the serialized credentials URL", async () => {
    config.environment = "production";

    await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      "http://localhost:21001",
      "stored-token",
    );
  });

  it("does not write when the profile is unchanged", async () => {
    const outcome = await validateStoredCredentials();

    expect(updateProfileMock).not.toHaveBeenCalled();
    expect(rotateMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: { user: { id: "u1", email: "old@traycer.ai", name: "Old" } },
    });
  });

  it("returns no-credentials when nothing is stored", async () => {
    readMock.mockResolvedValue(null);
    expect(await validateStoredCredentials()).toEqual({
      kind: "no-credentials",
    });
    expect(identityMock).not.toHaveBeenCalled();
  });

  it("returns network-error (without spending) when the access probe is unreachable", async () => {
    identityMock.mockResolvedValue({ kind: "network-error" });
    expect(await validateStoredCredentials()).toEqual({
      kind: "network-error",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("refreshes via the locked rotate when the access token is rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        token: "fresh-token",
        refreshToken: "fresh-refresh",
        authnBaseUrl: "http://localhost:21001",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });

    const outcome = await validateStoredCredentials();

    expect(rotateMock).toHaveBeenCalledWith({
      expectedUserId: "u1",
      expectedToken: "stored-token",
      refreshTokenOverride: null,
      signal: null,
    });
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: { token: "fresh-token", authnBaseUrl: config.authnBaseUrl },
    });
  });

  it("maps a dead refresh token to rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected",
      credentials: null,
    });
    expect(await validateStoredCredentials()).toEqual({ kind: "rejected" });
  });

  it("maps a transient rotate failure to network-error", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "refresh-network",
      credentials: null,
    });
    expect(await validateStoredCredentials()).toEqual({
      kind: "network-error",
    });
  });

  it("maps user-mismatch to rejected WITHOUT reporting the foreign account", async () => {
    // rotate carries the OTHER account's pair on user-mismatch; whoami must NOT
    // surface it as valid. This switch is independent of the host-rpc
    // revalidator's, so its cross-user safety needs its own guard here.
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "user-mismatch",
      credentials: {
        token: "foreign-token",
        refreshToken: "foreign-refresh",
        authnBaseUrl: "http://localhost:21001",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: { id: "u2", email: "other@traycer.ai", name: "Other" },
      },
    });
    expect(await validateStoredCredentials()).toEqual({ kind: "rejected" });
  });

  it("adopts a sibling's pair on superseded (valid)", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "superseded",
      credentials: {
        token: "sibling-token",
        refreshToken: "sibling-refresh",
        authnBaseUrl: "http://localhost:21001",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });
    expect(await validateStoredCredentials()).toMatchObject({
      kind: "valid",
      credentials: {
        token: "sibling-token",
        authnBaseUrl: config.authnBaseUrl,
      },
    });
  });

  it("maps a tombstoned file (a sign-out stands) to rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({ outcome: "tombstoned", credentials: null });
    expect(await validateStoredCredentials()).toEqual({ kind: "rejected" });
  });
});
