import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHostCredentialViaHttp } from "../../../../shared/auth/devices-sessions-fetcher";
import { createCliHostCredentialMintFlow } from "../host-credential-mint";

vi.mock("../../../../shared/auth/devices-sessions-fetcher", () => ({
  mintHostCredentialViaHttp: vi.fn(),
}));

const mintMock = vi.mocked(mintHostCredentialViaHttp);

afterEach(() => {
  vi.resetAllMocks();
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
      renewSignIn: null,
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
      renewSignIn: null,
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
      renewSignIn: null,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "superseded" as const },
    { kind: "unauthorized" as const, status: 401 as const },
    { kind: "network-error" as const },
  ])(
    "returns unavailable (never throws) when the server responds $kind, including the 409 supersede path",
    async (answer) => {
      mintMock.mockResolvedValue(answer);
      const diag = vi.fn();
      const flow = createCliHostCredentialMintFlow({
        authnBaseUrl: "https://authn.example.test",
        bearer: () => "user-jwt",
        diag,
        signal: null,
        unavailableNote: "continuing without a host credential.",
        onUnauthorized: null,
        renewSignIn: null,
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
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 401 });
    const onUnauthorized = vi.fn();
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      diag: () => undefined,
      signal: null,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized,
      renewSignIn: null,
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
        renewSignIn: null,
      });

      await expect(
        flow({ hostId: "host-1", reason: "missing" }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );
});

describe("createCliHostCredentialMintFlow renewSignIn", () => {
  const MISSING = { hostId: "host-1", reason: "missing" } as const;

  /** A flow whose `bearer()` is whatever the test's sign-in currently holds. */
  function flowOn(
    signIn: { token: string },
    renewSignIn: () => Promise<boolean>,
    onUnauthorized: () => void,
    diag: (line: string) => void,
    signal: AbortSignal | null,
  ) {
    return createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => signIn.token,
      diag,
      signal,
      unavailableNote: "continuing without a host credential.",
      onUnauthorized,
      renewSignIn,
    });
  }

  function bearersSent(): readonly string[] {
    return mintMock.mock.calls.map(([, bearer]) => bearer);
  }

  it("renews once on a 401 and sends the mint once more on the new bearer", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => {
      signIn.token = "new-jwt";
      return true;
    });
    const onUnauthorized = vi.fn<() => void>();
    mintMock
      .mockResolvedValueOnce({ kind: "unauthorized", status: 401 })
      .mockResolvedValueOnce({ kind: "ok", response: okMintBody("host-1") });
    const flow = flowOn(
      signIn,
      renewSignIn,
      onUnauthorized,
      () => undefined,
      null,
    );

    await expect(flow(MISSING)).resolves.toMatchObject({
      kind: "provisioned",
      token: "host-access-jws",
    });

    expect(renewSignIn).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(["old-jwt", "new-jwt"]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("ends after one renewal when the mint is refused again on the new bearer, and still reports the refusal", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => {
      signIn.token = "new-jwt";
      return true;
    });
    const onUnauthorized = vi.fn<() => void>();
    const diag = vi.fn<(line: string) => void>();
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 401 });
    const flow = flowOn(signIn, renewSignIn, onUnauthorized, diag, null);

    await expect(flow(MISSING)).resolves.toEqual({ kind: "unavailable" });

    expect(renewSignIn).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(["old-jwt", "new-jwt"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(diag).toHaveBeenCalledWith(
      "could not provision host host-1 (unauthorized); continuing without a host credential.",
    );
  });

  it("leaves the advisory unauthorized line, and sends no second mint, when the renewal is refused", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => false);
    const onUnauthorized = vi.fn<() => void>();
    const diag = vi.fn<(line: string) => void>();
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 401 });
    const flow = flowOn(signIn, renewSignIn, onUnauthorized, diag, null);

    await expect(flow(MISSING)).resolves.toEqual({ kind: "unavailable" });

    expect(renewSignIn).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(["old-jwt"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls).toEqual([
      [
        "could not provision host host-1 (unauthorized); continuing without a host credential.",
      ],
    ]);
  });

  it("does not renew on a 403, and reports the refusal as before", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => true);
    const onUnauthorized = vi.fn<() => void>();
    const diag = vi.fn<(line: string) => void>();
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 403 });
    const flow = flowOn(signIn, renewSignIn, onUnauthorized, diag, null);

    await expect(flow(MISSING)).resolves.toEqual({ kind: "unavailable" });

    expect(renewSignIn).not.toHaveBeenCalled();
    expect(bearersSent()).toEqual(["old-jwt"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls).toEqual([
      [
        "could not provision host host-1 (unauthorized); continuing without a host credential.",
      ],
    ]);
  });

  it("does not renew when the service never answers: the mint ends on the flow's own signal with no renewal", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => true);
    const bound = new AbortController();
    // The real call turns an aborted request into "network-error".
    mintMock.mockImplementation(
      (_url, _bearer, _request, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ kind: "network-error" }),
          );
        }),
    );
    const flow = flowOn(
      signIn,
      renewSignIn,
      () => undefined,
      () => undefined,
      bound.signal,
    );

    const settled = flow(MISSING);
    bound.abort();

    await expect(settled).resolves.toEqual({ kind: "unavailable" });
    expect(renewSignIn).not.toHaveBeenCalled();
    expect(bearersSent()).toEqual(["old-jwt"]);
  });

  it("sends only the first mint when a 401 is followed by a renewal that never answers, ending on the flow's own signal", async () => {
    const signIn = { token: "old-jwt" };
    const bound = new AbortController();
    const renewSignIn = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise((resolve) => {
          bound.signal.addEventListener("abort", () => resolve(false));
        }),
    );
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 401 });
    const flow = flowOn(
      signIn,
      renewSignIn,
      () => undefined,
      () => undefined,
      bound.signal,
    );

    const settled = flow(MISSING);
    await vi.waitFor(() => expect(renewSignIn).toHaveBeenCalledTimes(1));
    bound.abort();

    await expect(settled).resolves.toEqual({ kind: "unavailable" });
    expect(renewSignIn).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(["old-jwt"]);
  });

  it("renews once for the whole flow: a later mint refused with a 401 does not renew again", async () => {
    const signIn = { token: "old-jwt" };
    const renewSignIn = vi.fn<() => Promise<boolean>>(async () => false);
    mintMock.mockResolvedValue({ kind: "unauthorized", status: 401 });
    const flow = flowOn(
      signIn,
      renewSignIn,
      () => undefined,
      () => undefined,
      null,
    );

    await flow(MISSING);
    await flow({ hostId: "host-2", reason: "missing" });

    expect(renewSignIn).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(["old-jwt", "old-jwt"]);
  });
});
