import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintTeamComputerInstallTokenBySlugViaHttp,
  mintTeamComputerInstallTokenViaHttp,
} from "../team-computer-install";

const AUTHN = "https://authn.example.test";
const BEARER = "user-jwt-secret";
const INSTALL_TOKEN = "install-token-secret";
const ENVIRONMENT_ID = "environment-1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mintTeamComputerInstallTokenViaHttp", () => {
  it("POSTs the environment to authn and returns the issued token and expiry", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(201, {
        token: INSTALL_TOKEN,
        environmentId: ENVIRONMENT_ID,
        expiresAt: 1_800_000_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintTeamComputerInstallTokenViaHttp(
      AUTHN,
      BEARER,
      ENVIRONMENT_ID,
    );

    expect(result).toEqual({
      kind: "ok",
      token: INSTALL_TOKEN,
      environmentId: ENVIRONMENT_ID,
      expiresAt: 1_800_000_000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://authn.example.test/api/v3/hosts/team-install-tokens",
    );
    expect(url).not.toContain("/bots/");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${BEARER}`,
    );
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ environmentId: ENVIRONMENT_ID }));
  });

  it("accepts authn's resolved environment id when minting by team slug", async () => {
    const resolvedEnvironmentId = "resolved-environment-acme";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(201, {
        token: INSTALL_TOKEN,
        environmentId: resolvedEnvironmentId,
        expiresAt: 1_800_000_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mintTeamComputerInstallTokenBySlugViaHttp(AUTHN, BEARER, "acme"),
    ).resolves.toEqual({
      kind: "ok",
      token: INSTALL_TOKEN,
      environmentId: resolvedEnvironmentId,
      expiresAt: 1_800_000_000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://authn.example.test/api/v3/hosts/team-install-tokens",
    );
    expect(init?.body).toBe(JSON.stringify({ environmentId: "acme" }));
    expect(init?.redirect).toBe("manual");
  });

  it("treats a redirect as a non-success without exposing its token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(302, {
          token: INSTALL_TOKEN,
          environmentId: ENVIRONMENT_ID,
          expiresAt: 1_800_000_000,
        }),
      ),
    );

    const result = await mintTeamComputerInstallTokenBySlugViaHttp(
      AUTHN,
      BEARER,
      "acme",
    );

    expect(result).toEqual({
      kind: "network-error",
      detail: "the install-token request answered HTTP 302",
    });
    expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
  });

  it("rejects malformed or mismatched success bodies without exposing body secrets", async () => {
    const malformedBody = {
      token: INSTALL_TOKEN,
      environmentId: ENVIRONMENT_ID,
      expiresAt: "not-an-expiry",
      leakedCredential: BEARER,
    };
    const mismatchedBody = {
      token: INSTALL_TOKEN,
      environmentId: "another-environment",
      expiresAt: 1_800_000_000,
      leakedCredential: BEARER,
    };

    for (const body of [malformedBody, mismatchedBody]) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => jsonResponse(200, body)),
      );

      const result = await mintTeamComputerInstallTokenViaHttp(
        AUTHN,
        BEARER,
        ENVIRONMENT_ID,
      );

      expect(result).toEqual({
        kind: "network-error",
        detail: "the install-token answer did not match the request",
      });
      expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
      expect(JSON.stringify(result)).not.toContain(BEARER);
    }
  });

  it("keeps known refusal codes and scrubs unknown response details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(403, {
          code: "environment_action_forbidden",
          token: INSTALL_TOKEN,
        }),
      ),
    );
    expect(
      await mintTeamComputerInstallTokenViaHttp(AUTHN, BEARER, ENVIRONMENT_ID),
    ).toEqual({
      kind: "refused",
      status: 403,
      code: "environment_action_forbidden",
    });

    const reflectedSecret = `${BEARER}:${INSTALL_TOKEN}`;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(403, {
          code: reflectedSecret,
          message: reflectedSecret,
        }),
      ),
    );
    const result = await mintTeamComputerInstallTokenViaHttp(
      AUTHN,
      BEARER,
      ENVIRONMENT_ID,
    );
    expect(result).toEqual({
      kind: "network-error",
      detail: "the install-token request answered HTTP 403",
    });
    expect(JSON.stringify(result)).not.toContain(reflectedSecret);
  });

  it("returns a fixed diagnostic when fetch throws an error containing credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error(
          `request failed for Bearer ${BEARER}; token=${INSTALL_TOKEN}`,
        );
      }),
    );

    const result = await mintTeamComputerInstallTokenViaHttp(
      AUTHN,
      BEARER,
      ENVIRONMENT_ID,
    );

    expect(result).toEqual({
      kind: "network-error",
      detail: "the install-token request did not complete",
    });
    expect(JSON.stringify(result)).not.toContain(BEARER);
    expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
  });

  it("settles at the 15-second timeout and clears its timer after an answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    let settled = false;
    const pending = mintTeamComputerInstallTokenViaHttp(
      AUTHN,
      BEARER,
      ENVIRONMENT_ID,
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({
      kind: "network-error",
      detail: "the install-token request did not complete",
    });
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
