import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditOffer } from "@traycer/protocol/auth/credit-offers";
import {
  claimCreditOfferViaHttp,
  listCreditOffersViaHttp,
  type ClaimCreditOfferFetchResult,
} from "../credit-offers";

const AUTHN_BASE_URL = "https://authn.example.test";
const BEARER = "bearer-token";

const CARD: CreditOffer = {
  id: "campaign-1",
  name: "Desktop offer",
  description: "For the launch models",
  grantCredits: 500,
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-12-31T00:00:00.000Z",
  claim: "none",
  remainingCredits: null,
};

const fetchMock = vi.fn<typeof fetch>();

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCreditOffersViaHttp", () => {
  it("sends one authenticated GET to the credit campaigns path and returns the offers", async () => {
    respond(200, { campaigns: [CARD] });

    const result = await listCreditOffersViaHttp(AUTHN_BASE_URL, BEARER, null);

    expect(result).toEqual({ kind: "ok", offers: [CARD] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTHN_BASE_URL}/api/user/credit-campaigns`);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${BEARER}`,
    );
  });

  it.each([
    { status: 401, kind: "unauthorized" },
    { status: 403, kind: "unauthorized" },
    { status: 500, kind: "network-error" },
  ])("maps HTTP $status to $kind", async ({ status, kind }) => {
    respond(status, { statusCode: status, error: "ANYTHING" });

    expect(await listCreditOffersViaHttp(AUTHN_BASE_URL, BEARER, null)).toEqual(
      { kind },
    );
  });

  it("reports a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));

    expect(await listCreditOffersViaHttp(AUTHN_BASE_URL, BEARER, null)).toEqual(
      { kind: "network-error" },
    );
  });

  it("reports a network error for a 200 body it cannot parse", async () => {
    respond(200, { campaigns: "none" });

    expect(await listCreditOffersViaHttp(AUTHN_BASE_URL, BEARER, null)).toEqual(
      { kind: "network-error" },
    );
  });
});

describe("claimCreditOfferViaHttp", () => {
  it("posts the campaign id as JSON to the claim path", async () => {
    respond(200, { campaign: CARD });

    await claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTHN_BASE_URL}/api/user/credit-campaigns/claim`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ campaignId: CARD.id }));
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  const CLAIMED: CreditOffer = {
    ...CARD,
    claim: "active",
    remainingCredits: 500,
  };

  const cases: ReadonlyArray<{
    name: string;
    status: number;
    body: unknown;
    expected: ClaimCreditOfferFetchResult;
  }> = [
    {
      name: "200 with the claimed card",
      status: 200,
      body: { campaign: CLAIMED },
      expected: { kind: "ok", offer: CLAIMED },
    },
    {
      name: "200 with a card it cannot read",
      status: 200,
      body: { campaign: { ...CLAIMED, claim: "paused" } },
      expected: { kind: "ok", offer: null },
    },
    {
      name: "409 already claimed",
      status: 409,
      body: { statusCode: 409, error: "CREDIT_CAMPAIGN_ALREADY_CLAIMED" },
      expected: { kind: "conflict" },
    },
    {
      name: "409 sold out",
      status: 409,
      body: { statusCode: 409, error: "CREDIT_CAMPAIGN_SOLD_OUT" },
      expected: { kind: "unavailable", reason: "sold-out" },
    },
    {
      name: "409 not active",
      status: 409,
      body: { statusCode: 409, error: "CREDIT_CAMPAIGN_NOT_ACTIVE" },
      expected: { kind: "unavailable", reason: "not-running" },
    },
    {
      name: "409 with an unknown code",
      status: 409,
      body: { statusCode: 409, error: "SOMETHING_NEW" },
      expected: { kind: "network-error" },
    },
    {
      name: "404",
      status: 404,
      body: { statusCode: 404, error: "Not Found" },
      expected: { kind: "unavailable", reason: "not-running" },
    },
    {
      name: "403 plan ineligible",
      status: 403,
      body: { statusCode: 403, error: "CREDIT_CAMPAIGN_PLAN_INELIGIBLE" },
      expected: { kind: "unavailable", reason: "ineligible" },
    },
    {
      name: "403 with any other body",
      status: 403,
      body: { statusCode: 403, error: "Forbidden" },
      expected: { kind: "unauthorized" },
    },
    {
      name: "401",
      status: 401,
      body: { statusCode: 401, error: "Unauthorized" },
      expected: { kind: "unauthorized" },
    },
    {
      name: "500",
      status: 500,
      body: { statusCode: 500, error: "Internal Server Error" },
      expected: { kind: "network-error" },
    },
  ];

  it.each(cases)("maps $name", async ({ status, body, expected }) => {
    respond(status, body);

    expect(
      await claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id),
    ).toEqual(expected);
  });

  it("reports a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));

    expect(
      await claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id),
    ).toEqual({ kind: "network-error" });
  });
});

describe("a response whose body stalls after its headers", () => {
  /**
   * Headers arrive at once; the body never does. As a real fetch does, the
   * request's signal errors the body stream when it aborts.
   */
  function respondThenStall(status: number): void {
    fetchMock.mockImplementation((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times the list out as a network error", async () => {
    respondThenStall(200);

    const result = listCreditOffersViaHttp(AUTHN_BASE_URL, BEARER, null);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toEqual({ kind: "network-error" });
  });

  it("times a refused claim out as a network error, so it never stays pending", async () => {
    respondThenStall(409);

    const result = claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toEqual({ kind: "network-error" });
  });
});

describe("a claim on a fetch that ignores its signal", () => {
  // CREDIT_OFFERS_FETCH_TIMEOUT_MS
  const CLAIM_TIMEOUT_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at the deadline as a network error when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    let settled = false;

    const pending = claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CLAIM_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });

  it("settles at the deadline with the claim taken and no card when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const json = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise<unknown>(() => undefined));
    fetchMock.mockResolvedValue(response);
    let settled = false;

    const pending = claimCreditOfferViaHttp(AUTHN_BASE_URL, BEARER, CARD.id);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CLAIM_TIMEOUT_MS - 1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ kind: "ok", offer: null });
  });
});
