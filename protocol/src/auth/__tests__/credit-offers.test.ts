import { describe, expect, it } from "vitest";
import {
  claimCreditOfferResponseSchema,
  listCreditOffersResponseSchema,
  type CreditOffer,
} from "@traycer/protocol/auth/credit-offers";

function card(overrides: Partial<CreditOffer>): CreditOffer {
  return {
    id: "campaign-1",
    name: "Desktop offer",
    description: null,
    grantCredits: 500,
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-12-31T00:00:00.000Z",
    claim: "none",
    remainingCredits: null,
    ...overrides,
  };
}

describe("listCreditOffersResponseSchema", () => {
  it("strips keys it does not know instead of failing the card", () => {
    const parsed = listCreditOffersResponseSchema.parse({
      campaigns: [{ ...card({}), addedByANewerServer: true }],
    });

    expect(parsed).toEqual({ campaigns: [card({})] });
  });

  it("drops a card with an unknown claim state and keeps the cards around it", () => {
    const before = card({ id: "before" });
    const after = card({ id: "after", claim: "active", remainingCredits: 40 });

    const parsed = listCreditOffersResponseSchema.parse({
      campaigns: [
        before,
        { ...card({ id: "future" }), claim: "paused" },
        after,
      ],
    });

    expect(parsed.campaigns).toEqual([before, after]);
  });

  it.each([
    ["a date without a time", { endsAt: "2026-12-31" }],
    ["a locale date", { endsAt: "12/31/2026" }],
    ["a start that is not a date", { startsAt: "soon" }],
  ])("drops a card with %s and keeps the cards around it", (_n, dates) => {
    const kept = card({ id: "kept" });

    const parsed = listCreditOffersResponseSchema.parse({
      campaigns: [{ ...card({ id: "bad" }), ...dates }, kept],
    });

    expect(parsed.campaigns).toEqual([kept]);
  });

  it("fails when campaigns is not an array", () => {
    expect(
      listCreditOffersResponseSchema.safeParse({ campaigns: "none" }).success,
    ).toBe(false);
  });
});

describe("claimCreditOfferResponseSchema", () => {
  it("reads the claimed card", () => {
    const claimed = card({ claim: "active", remainingCredits: 500 });

    expect(claimCreditOfferResponseSchema.parse({ campaign: claimed })).toEqual(
      { campaign: claimed },
    );
  });

  it("parses with a null campaign when the card is unreadable", () => {
    const parsed = claimCreditOfferResponseSchema.parse({
      campaign: { ...card({}), claim: "paused" },
    });

    expect(parsed).toEqual({ campaign: null });
  });
});
