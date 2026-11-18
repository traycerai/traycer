import type { AccountContext } from "@traycer/protocol/common/schemas";
import { appLogger, describeLogError } from "@/lib/logger";

/**
 * The platform (cloud UI) origin this build is actually pointed at, taken from
 * the shell's `signInUrl`.
 *
 * `signInUrl` is the right source because it is ALREADY the platform origin on
 * every shell: desktop composes it from `config.cloudUiBaseUrl`, and the mobile
 * entry from the baked `cloudUiBaseUrl` too. Nothing is inferred, so there is
 * no deployment this can be wrong about.
 *
 * It is explicitly NOT derived from `authnBaseUrl`. That derivation worked by
 * rewriting an `authn.` hostname label into `platform.`, which silently has no
 * answer for a loopback or LAN-IP backend — the physical-phone dev lane bakes
 * exactly those (`clients/mobile/scripts/dev-ios-device.ts`) — and a fallback
 * there means guessing a DIFFERENT DEPLOYMENT than the one that issued the
 * data being encoded.
 */
export function platformOriginFromSignInUrl(signInUrl: string): string | null {
  try {
    const parsed = new URL(signInUrl);
    // `URL.origin` is the STRING "null" for any scheme with an opaque origin -
    // `file:`, `data:`, a custom scheme. Those parse without throwing, so
    // without this guard the strict form returns "null" as if it were an
    // address, and a caller that trusts it composes `null/link?code=<live>`.
    // The whole contract here is that no answer is better than a wrong one.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      appLogger.warn("[auth] sign-in URL has a non-web scheme", {
        scheme: parsed.protocol,
      });
      return null;
    }
    return parsed.origin;
  } catch (error) {
    appLogger.warn("[auth] sign-in URL has no parseable origin", {
      error: describeLogError(error),
    });
    return null;
  }
}

/** Where a user with no configured platform origin is sent. */
const PRODUCTION_PLATFORM_URL = "https://traycer.ai";

/**
 * The platform origin for NAVIGATION — the Billing page jump and anything else
 * that just opens a page.
 *
 * This one may fall back to production, and the distinction from
 * `platformOriginFromSignInUrl` is the whole point: sending a person to the
 * production dashboard when their shell reported an unusable sign-in URL costs
 * them a wrong page they can see and leave. Sending DATA to the wrong
 * deployment is a different class of mistake, so anything carrying a value —
 * the link-login QR above all — must use the strict function and render
 * nothing rather than address the wrong origin.
 */
export function resolvePlatformBaseUrl(signInUrl: string): string {
  return platformOriginFromSignInUrl(signInUrl) ?? PRODUCTION_PLATFORM_URL;
}

/** The fields of a team the Billing path needs: which team, and its URL slug. */
export interface BillingTeam {
  readonly teamId: string;
  readonly slug: string;
}

/**
 * The platform path of the Billing page for an account context.
 *
 * The platform origin's root is the marketing homepage, so every billing
 * affordance ("Manage subscription", "Upgrade") names a page, never the bare
 * origin. A team context opens that team's billing page, which is also where a
 * team with no plan is offered one; the personal context opens the user's own.
 *
 * A team context that cannot be named in a URL - the stored team id is not
 * among `teams` (the user left it, or the list has not loaded), or its slug is
 * empty - opens the personal page instead. That is the same fallback
 * `resolveAccountContext` applies to a stale team, and a page the user can see
 * and switch from beats a `/team//billing` that resolves to nothing.
 */
export function billingPathFor(
  accountContext: AccountContext,
  teams: ReadonlyArray<BillingTeam>,
): string {
  if (accountContext.type !== "TEAM") return "/billing";
  const team = teams.find((t) => t.teamId === accountContext.teamId);
  if (team === undefined || team.slug.length === 0) return "/billing";
  return `/team/${encodeURIComponent(team.slug)}/billing`;
}

/** The full Billing page URL: {@link resolvePlatformBaseUrl} + {@link billingPathFor}. */
export function resolvePlatformBillingUrl(
  signInUrl: string,
  accountContext: AccountContext,
  teams: ReadonlyArray<BillingTeam>,
): string {
  return `${resolvePlatformBaseUrl(signInUrl)}${billingPathFor(accountContext, teams)}`;
}
