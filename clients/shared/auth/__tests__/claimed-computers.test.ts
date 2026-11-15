import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { fetchClaimedComputers } from "../claimed-computers";
import { createOpaqueRedirectResponse } from "../../test-fixtures/opaque-redirect";

const BASE = "https://authn.example.test/";
const TOKEN = "member-session-token";
const ENVIRONMENT_ID = "team /A";
const CLAIM = {
  hostId: "host-1",
  computerName: null,
  claimantName: "Ada",
  claimedAt: "2026-11-15T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(respond: () => Promise<Response>): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClaimedComputers", () => {
  it("GETs the member's claims on their sign-in without following a redirect", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { claims: [CLAIM] }),
    );

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual({ kind: "ok", claims: [CLAIM] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe(
      "https://authn.example.test/api/v3/environments/team%20%2FA/claimed-computers",
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.redirect).toBe("manual");
  });

  it("reads a browser's opaque redirect as failed, with the bearer sent once and never followed", async () => {
    const fetchMock = stubFetch(async () => createOpaqueRedirectResponse());

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual({ kind: "failed" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([
    [401, { kind: "unauthorized" }],
    [404, { kind: "not-found" }],
    [302, { kind: "failed" }],
    [500, { kind: "failed" }],
  ] as const)("maps HTTP %i to %o", async (status, result) => {
    stubFetch(async () => new Response(null, { status }));

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual(result);
  });

  it("reads a 307 whose body is a valid claims list as failed, never as the claims", async () => {
    const fetchMock = stubFetch(
      async () =>
        new Response(JSON.stringify({ claims: [CLAIM] }), {
          status: 307,
          headers: { location: "https://elsewhere.test/collect" },
        }),
    );

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual({ kind: "failed" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([
    ["missing claims", {}],
    [
      "a claim with no claimant name",
      { claims: [{ ...CLAIM, claimantName: null }] },
    ],
    [
      "epoch milliseconds instead of a date string",
      { claims: [{ ...CLAIM, claimedAt: 1_763_164_800_000 }] },
    ],
  ])("fails closed for %s", async (_label, body) => {
    stubFetch(async () => jsonResponse(200, body));

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("returns failed on a network error", async () => {
    stubFetch(async () => {
      throw new Error("transport error");
    });

    await expect(
      fetchClaimedComputers(BASE, TOKEN, ENVIRONMENT_ID, null),
    ).resolves.toEqual({ kind: "failed" });
  });
});
