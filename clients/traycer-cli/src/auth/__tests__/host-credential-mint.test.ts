import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHostCredentialViaHttp } from "../../../../shared/auth/devices-sessions-fetcher";
import { createCliHostCredentialMintFlow } from "../host-credential-mint";

vi.mock("../../../../shared/auth/devices-sessions-fetcher", () => ({
  mintHostCredentialViaHttp: vi.fn(),
}));

const mintMock = vi.mocked(mintHostCredentialViaHttp);

afterEach(() => {
  vi.clearAllMocks();
});

function okMintBody(hostId: string) {
  return {
    token: "host-access-jws",
    refreshToken: "host-refresh-jwe",
    familyId: "family-1",
    hostId,
    expiresIn: 900,
    provisionedAt: "2026-07-08T12:00:00.000Z",
  };
}

describe("createCliHostCredentialMintFlow", () => {
  it("returns provisioned on a single successful mint call", async () => {
    mintMock.mockResolvedValue({
      kind: "ok",
      response: okMintBody("host-1"),
    });
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      diag: () => undefined,
      signal: null,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized: null,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({
      kind: "provisioned",
      token: "host-access-jws",
      refreshToken: "host-refresh-jwe",
      familyId: "family-1",
      provisionedAt: "2026-07-08T12:00:00.000Z",
      expiresIn: 900,
    });
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith(
      "https://authn.example.test",
      "user-jwt",
      { hostId: "host-1", hostLabel: expect.any(String), platform: null },
      null,
    );
  });

  it("returns unavailable when the bearer is missing, without calling the server", async () => {
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => null,
      diag: () => undefined,
      signal: null,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized: null,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it("returns unavailable when the bearer is an empty string", async () => {
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "",
      diag: () => undefined,
      signal: null,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized: null,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "superseded" as const },
    { kind: "unauthorized" as const },
    { kind: "network-error" as const },
  ])(
    "returns unavailable (never throws) when the server responds $kind, including the 409 supersede path",
    async ({ kind }) => {
      mintMock.mockResolvedValue({ kind });
      const diag = vi.fn();
      const flow = createCliHostCredentialMintFlow({
        authnBaseUrl: "https://authn.example.test",
        bearer: () => "user-jwt",
        diag,
        signal: null,
        unavailableNote: "continuing without a host credential.",
        onUnauthorized: null,
      });

      await expect(
        flow({ hostId: "host-1", reason: "missing" }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(diag).toHaveBeenCalled();
    },
  );

  it("invokes onUnauthorized exactly once when the server responds unauthorized", async () => {
    // 401/403 from authn is NOT like the other mint failures: the same
    // stored bearer fails for every client, so a caller with a follow-up
    // (the host install probe) needs to know, even though the flow itself
    // still returns the same `unavailable` the stream contract has room for.
    mintMock.mockResolvedValue({ kind: "unauthorized" });
    const onUnauthorized = vi.fn();
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      diag: () => undefined,
      signal: null,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "superseded" as const },
    { kind: "network-error" as const },
  ])(
    "does not invoke onUnauthorized when the server responds $kind",
    async ({ kind }) => {
      mintMock.mockResolvedValue({ kind });
      const onUnauthorized = vi.fn();
      const flow = createCliHostCredentialMintFlow({
        authnBaseUrl: "https://authn.example.test",
        bearer: () => "user-jwt",
        diag: () => undefined,
        signal: null,
        unavailableNote: "continuing without a host credential.",
        onUnauthorized,
      });

      await expect(
        flow({ hostId: "host-1", reason: "missing" }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );
});
