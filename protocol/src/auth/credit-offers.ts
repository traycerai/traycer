import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Client-side mirror of authn-v3's credit campaign cards, which the apps call
 * credit offers: the list a signed-in user can claim from
 * (`GET api/user/credit-campaigns`) and the card a claim returns
 * (`POST api/user/credit-campaigns/claim`).
 *
 * Unlike link-login these schemas are lenient on purpose. Nothing here is a
 * credential, and an installed app outlives many server deploys: unknown keys
 * are stripped, and a card this client cannot read (an unknown `claim` state
 * included) is dropped from the list instead of failing it.
 */

/**
 * The caller's claim on an offer: none yet, none and every seat already
 * taken, claimed and still spendable, or claimed and since revoked.
 */
export type CreditOfferClaim = "none" | "sold_out" | "active" | "revoked";

export type CreditOffer = {
  id: string;
  name: string;
  description: string | null;
  grantCredits: number;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** ISO 8601, UTC. */
  endsAt: string;
  claim: CreditOfferClaim;
  /** Credits left on the claimed grant (0 once revoked); null when not claimed. */
  remainingCredits: number | null;
};

export type ListCreditOffersResponse = {
  campaigns: CreditOffer[];
};

export type ClaimCreditOfferResponse = {
  /**
   * The claimed card, or `null` when this client cannot read it. A 2xx means
   * the claim took either way, so an unreadable card must not turn it into a
   * failure.
   */
  campaign: CreditOffer | null;
};

const creditOfferSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    grantCredits: z.number(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    claim: z.enum(["none", "sold_out", "active", "revoked"]),
    remainingCredits: z.number().nullable(),
  }),
);

export const listCreditOffersResponseSchema: z.ZodType<ListCreditOffersResponse> =
  lazySchema(() =>
    z.object({
      campaigns: z.array(z.unknown()).transform((cards) =>
        cards.flatMap((card) => {
          const parsed = creditOfferSchema.safeParse(card);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    }),
  );

export const claimCreditOfferResponseSchema: z.ZodType<ClaimCreditOfferResponse> =
  lazySchema(() =>
    z.object({
      campaign: creditOfferSchema.nullable().catch(null),
    }),
  );
