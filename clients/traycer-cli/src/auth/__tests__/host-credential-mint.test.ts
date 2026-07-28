import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintHostCredentialViaHttp,
  requestStepUpChallengeViaHttp,
  verifyStepUpChallengeViaHttp,
} from "../../../../shared/auth/devices-sessions-fetcher";
import { createCliHostCredentialMintFlow } from "../host-credential-mint";

const { createInterfaceMock } = vi.hoisted(() => ({
  createInterfaceMock: vi.fn(),
}));

vi.mock("../../../../shared/auth/devices-sessions-fetcher", () => ({
  mintHostCredentialViaHttp: vi.fn(),
  requestStepUpChallengeViaHttp: vi.fn(),
  verifyStepUpChallengeViaHttp: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: createInterfaceMock,
}));

const mintMock = vi.mocked(mintHostCredentialViaHttp);
const challengeMock = vi.mocked(requestStepUpChallengeViaHttp);
const verifyMock = vi.mocked(verifyStepUpChallengeViaHttp);

afterEach(() => {
  vi.clearAllMocks();
});

function mockReadline(options: {
  readonly question: () => Promise<string> | string;
  readonly close?: () => void;
}): void {
  // Partial readline double: production only calls question/close.
  createInterfaceMock.mockReturnValue({
    question: async (): Promise<string> => await options.question(),
    close: options.close ?? (() => undefined),
  });
}

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
  it("returns declined before any HTTP when interactive is false", async () => {
    // Headless must not burn the mint budget or silently succeed on a still
    // step-up-fresh bearer — decline is checked before the first request.
    const diag = vi.fn();
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: false,
      diag,
    });

    const outcome = await flow({ hostId: "host-1", reason: "missing" });

    expect(outcome).toEqual({ kind: "declined" });
    expect(mintMock).not.toHaveBeenCalled();
    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(challengeMock).not.toHaveBeenCalled();
    expect(diag).toHaveBeenCalled();
  });

  it("maps a first-mint 409 supersede to unavailable without prompting", async () => {
    mintMock.mockResolvedValue({ kind: "superseded" });
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
      diag: () => undefined,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it("returns provisioned when the first mint already succeeds", async () => {
    mintMock.mockResolvedValue({
      kind: "ok",
      response: okMintBody("host-1"),
    });
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
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
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it("runs step-up challenge → code → re-mint with the step-up token", async () => {
    mintMock
      .mockResolvedValueOnce({ kind: "step-up-required" })
      .mockResolvedValueOnce({
        kind: "ok",
        response: okMintBody("host-1"),
      });
    challengeMock.mockResolvedValue({
      kind: "ok",
      response: { ok: true, expires_in: 300 },
    });
    verifyMock.mockResolvedValue({
      kind: "ok",
      response: {
        access_token: "step-up-token",
        token_type: "Bearer",
        expires_in: 900,
      },
    });

    const question = vi.fn(async () => "123456");
    const close = vi.fn();
    mockReadline({ question, close });

    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
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

    expect(mintMock).toHaveBeenCalledTimes(2);
    expect(mintMock.mock.calls[0]?.[1]).toBe("user-jwt");
    expect(mintMock.mock.calls[1]?.[1]).toBe("step-up-token");
    expect(verifyMock).toHaveBeenCalledWith(
      "https://authn.example.test",
      "user-jwt",
      "123456",
    );
    expect(close).toHaveBeenCalled();
  });

  it("re-prompts on a non-6-digit entry then accepts a valid code", async () => {
    mintMock
      .mockResolvedValueOnce({ kind: "step-up-required" })
      .mockResolvedValueOnce({
        kind: "ok",
        response: okMintBody("host-1"),
      });
    challengeMock.mockResolvedValue({
      kind: "ok",
      response: { ok: true, expires_in: 300 },
    });
    verifyMock.mockResolvedValue({
      kind: "ok",
      response: {
        access_token: "step-up-token",
        token_type: "Bearer",
        expires_in: 900,
      },
    });

    const answers = ["abcdef", "654321"];
    let answerIndex = 0;
    const question = vi.fn(async () => {
      const next = answers[answerIndex] ?? "";
      answerIndex += 1;
      return next;
    });
    mockReadline({ question });

    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
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
    expect(question).toHaveBeenCalledTimes(2);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock.mock.calls[0]?.[2]).toBe("654321");
  });

  it("returns declined on an empty line (skip)", async () => {
    mintMock.mockResolvedValue({ kind: "step-up-required" });
    challengeMock.mockResolvedValue({
      kind: "ok",
      response: { ok: true, expires_in: 300 },
    });
    const question = vi.fn(async () => "");
    mockReadline({ question });

    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
      diag: () => undefined,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("bounds incorrect codes to MAX_CODE_ATTEMPTS (3) then declines", async () => {
    mintMock.mockResolvedValue({ kind: "step-up-required" });
    challengeMock.mockResolvedValue({
      kind: "ok",
      response: { ok: true, expires_in: 300 },
    });
    verifyMock.mockResolvedValue({ kind: "invalid" });

    const question = vi.fn(async () => "111111");
    mockReadline({ question });

    const diag = vi.fn();
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => "user-jwt",
      interactive: true,
      diag,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });

    expect(question).toHaveBeenCalledTimes(3);
    expect(verifyMock).toHaveBeenCalledTimes(3);
    expect(diag).toHaveBeenCalledWith(
      expect.stringContaining("too many incorrect codes"),
    );
  });

  it("returns unavailable when the bearer is missing", async () => {
    const flow = createCliHostCredentialMintFlow({
      authnBaseUrl: "https://authn.example.test",
      bearer: () => null,
      interactive: true,
      diag: () => undefined,
    });

    await expect(
      flow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintMock).not.toHaveBeenCalled();
  });
});
