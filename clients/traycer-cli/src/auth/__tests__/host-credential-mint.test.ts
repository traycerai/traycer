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
    );
  });

  it("returns unavailable when the bearer is missing, without calling the server", async () => {
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => null,
      diag: () => undefined,
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
      });

      await expect(
        flow({ hostId: "host-1", reason: "missing" }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(diag).toHaveBeenCalled();
    },
  );
});
