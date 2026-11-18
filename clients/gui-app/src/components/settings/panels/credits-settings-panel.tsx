/**
 * Account ▸ Credits. E4 mounts this under the `credits` row. The balance is
 * the signed-in user's remaining credits, $0.00 included (a user with no
 * subscription has none); `Add credits ↗` opens the dashboard billing page.
 * In the personal account context, credit offers are listed under it, never
 * added into it: the claimed ones the user record carries, then the ones still
 * open to claim.
 */
import type { AuthenticatedUserCampaignCredit } from "@traycer/protocol/auth";
import type { CreditOffer } from "@traycer/protocol/auth/credit-offers";
import { formatDistanceStrict } from "date-fns";
import { ExternalLink, Info, Timer } from "lucide-react";
import { useId, type ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { CREDITS_PAGE } from "@/components/settings/panels/credits-settings.definitions";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useAuthClaimCreditOffer } from "@/hooks/auth/use-claim-credit-offer-mutation";
import { useAuthListCreditOffers } from "@/hooks/auth/use-credit-offers-query";
import { usePlatformBillingUrl } from "@/hooks/auth/use-platform-billing-url";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
import {
  formatCredits,
  formatCreditsPlain,
} from "@/lib/auth/traycer-subscription-content";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenLink, type OpenLink } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import { isMobileApp } from "@/lib/mobile-app";
import { useSampledNow } from "@/lib/relative-time";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { sandboxBalanceMc } from "@/lib/sandboxes/sandbox-balance";
import {
  resolveAccountContext,
  useAccountContextStore,
} from "@/stores/auth/account-context-store";

const MC_PER_CREDIT = 1000;

const NO_OFFERS: ReadonlyArray<AuthenticatedUserCampaignCredit> = [];
const NO_LISTED_OFFERS: ReadonlyArray<CreditOffer> = [];
const NO_OFFER_ROWS: ReadonlyArray<OfferRow> = [];

/**
 * One row of the offers section: an offer the user holds, or one still open
 * to claim (or every seat of which is taken).
 */
type OfferRow =
  | {
      readonly kind: "claimed";
      readonly offer: AuthenticatedUserCampaignCredit;
    }
  | { readonly kind: "claimable"; readonly offer: CreditOffer };

/**
 * The user record's claimed offers, then each listed offer the record does
 * not already carry. A listed `active` offer is one the record has not caught
 * up with yet (a claim just made, or one credit-service has not applied), so
 * it shows as claimed rather than back as "Claim". A revoked one never shows.
 */
function offerRows(
  claimed: ReadonlyArray<AuthenticatedUserCampaignCredit>,
  listed: ReadonlyArray<CreditOffer>,
): ReadonlyArray<OfferRow> {
  const claimedIds = new Set(claimed.map((offer) => offer.campaignId));
  const rows: OfferRow[] = claimed.map((offer) => ({ kind: "claimed", offer }));
  for (const offer of listed) {
    if (claimedIds.has(offer.id)) continue;
    if (offer.claim === "active") {
      rows.push({
        kind: "claimed",
        offer: {
          campaignId: offer.id,
          name: offer.name,
          description: offer.description,
          grantCredits: offer.grantCredits,
          remainingCredits: offer.remainingCredits ?? offer.grantCredits,
          endsAt: offer.endsAt,
        },
      });
    } else if (offer.claim === "none" || offer.claim === "sold_out") {
      rows.push({ kind: "claimable", offer });
    }
  }
  return rows;
}

// An offer's exact end, in the viewer's own time zone, for the hover on "left".
const offerEndFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Dollars on desktop; bare credits in the installed app, as the balance. */
function formatAmount(credits: number, installedApp: boolean): string {
  return installedApp
    ? `${formatCreditsPlain(credits)} credits`
    : formatCredits(credits);
}

export function CreditsSettingsPanel(): ReactNode {
  const query = useAuthUser();
  useRefreshCreditsOnTraycerTurn();
  const billingUrl = usePlatformBillingUrl();
  const openLink = useOpenLink();
  const installedApp = isMobileApp();

  const user = query.data ?? null;
  const remainingMc = sandboxBalanceMc(user);

  // Offers belong to the personal account, so a team context neither asks for
  // nor shows them. Resolved against the loaded user's teams, as the subscription card
  // resolves it, so a stale stored team cannot read as personal before then.
  const storedContext = useAccountContextStore((s) => s.accountContext);
  const personal =
    user !== null &&
    resolveAccountContext(
      storedContext,
      new Set(user.teamSubscriptions.map((t) => t.team.id)),
    ).type === "PERSONAL";
  const offersQuery = useAuthListCreditOffers(personal);
  const claim = useAuthClaimCreditOffer();
  // A failed read keeps the last list cached; the claimable rows hide instead.
  const listed =
    personal && !offersQuery.isError
      ? (offersQuery.data ?? NO_LISTED_OFFERS)
      : NO_LISTED_OFFERS;

  return (
    <SettingsPanelShell
      title={CREDITS_PAGE.label}
      description={CREDITS_PAGE.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
      headerAction={
        <RefreshIconButton
          onRefresh={async () => {
            await Promise.all([
              query.refetch(),
              personal ? offersQuery.refetch() : null,
            ]);
          }}
          label="Refresh credits"
          refreshing={query.isFetching || (personal && offersQuery.isFetching)}
        />
      }
    >
      <CreditsBody
        pending={query.isPending}
        error={query.isError}
        onRetry={() => void query.refetch()}
        remainingMc={remainingMc}
        offers={
          personal
            ? offerRows(user.campaignCredits ?? NO_OFFERS, listed)
            : NO_OFFER_ROWS
        }
        claimingId={claim.isPending ? claim.variables : null}
        onClaim={(campaignId) => claim.mutate(campaignId)}
        installedApp={installedApp}
        billingUrl={billingUrl}
        openLink={openLink}
      />
    </SettingsPanelShell>
  );
}

function CreditsBody(props: {
  readonly pending: boolean;
  readonly error: boolean;
  readonly onRetry: () => void;
  readonly remainingMc: number | null;
  readonly offers: ReadonlyArray<OfferRow>;
  /** The offer a claim is in flight for; every Claim waits on it. */
  readonly claimingId: string | null;
  readonly onClaim: (campaignId: string) => void;
  readonly installedApp: boolean;
  readonly billingUrl: string;
  readonly openLink: OpenLink;
}): ReactNode {
  if (props.pending) {
    return (
      <div
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="credits-loading"
      >
        <MutedAgentSpinner /> Loading credits
      </div>
    );
  }
  if (props.error) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-baseline gap-x-1 text-ui-sm text-muted-foreground"
        data-testid="credits-error"
      >
        {CREDITS_PAGE.readFailed}
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={props.onRetry}
        >
          Retry
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't read your credits",
            message: null,
            code: null,
            source: "Credits",
          })}
          presentation="link"
          className="ml-1"
        />
      </div>
    );
  }
  const remainingCredits = (props.remainingMc ?? 0) / MC_PER_CREDIT;
  const remainingLabel = CREDITS_PAGE.remaining(
    formatAmount(remainingCredits, props.installedApp),
  );
  return (
    <div className="flex flex-col gap-6">
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
        data-testid="credits-ready"
      >
        <p
          className="text-title-md font-semibold tabular-nums text-foreground"
          data-testid="credits-remaining"
        >
          {remainingLabel}
        </p>
        {props.installedApp ? null : (
          <AddCreditsButton
            billingUrl={props.billingUrl}
            openLink={props.openLink}
          />
        )}
      </div>
      <CreditOffers
        offers={props.offers}
        claimingId={props.claimingId}
        onClaim={props.onClaim}
        installedApp={props.installedApp}
      />
    </div>
  );
}

/**
 * Offers that have not ended, each spendable only on its own models, so none
 * of them is part of the balance above: the claimed ones with what is left,
 * then the ones still open to claim.
 */
function CreditOffers(props: {
  readonly offers: ReadonlyArray<OfferRow>;
  readonly claimingId: string | null;
  readonly onClaim: (campaignId: string) => void;
  readonly installedApp: boolean;
}): ReactNode {
  const headingId = useId();
  // The auth user does not poll, so an offer that ends while the panel is open
  // leaves on the shared minute clock rather than on the next refresh.
  const now = useSampledNow();
  const live = props.offers.filter((row) => Date.parse(row.offer.endsAt) > now);
  if (live.length === 0) return null;
  return (
    // A container, so a narrow pane (the phone, a slim modal) moves the time
    // under the offer's name instead of squeezing the name into a sliver.
    <section
      aria-labelledby={headingId}
      className="@container"
      data-testid="credits-offers"
    >
      <div className="mb-1.5 flex items-center gap-0.5 px-1">
        <h2
          id={headingId}
          className="font-semibold text-ui-xs text-muted-foreground"
        >
          {CREDITS_PAGE.offersTitle}
        </h2>
        {/* A popover, not a tooltip: it opens on tap, so the phone can read
            the terms too. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="muted"
              size="icon-xs"
              aria-label={CREDITS_PAGE.offersAbout}
              data-testid="credits-offers-about"
            >
              <Info aria-hidden className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-label={CREDITS_PAGE.offersAbout}>
            <p>{CREDITS_PAGE.offersTerms}</p>
          </PopoverContent>
        </Popover>
      </div>
      {/* Subgrid rows: the figure column is as wide as the widest figure, so
          every row's name starts at the same edge. */}
      <ul className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 divide-y divide-border/60 rounded-lg border border-border/60 bg-card/40 px-5 @md:grid-cols-[auto_minmax(0,1fr)_auto]">
        {live.map((row) =>
          row.kind === "claimed" ? (
            <CreditOfferRow
              key={row.offer.campaignId}
              offer={row.offer}
              installedApp={props.installedApp}
            />
          ) : (
            <ClaimableOfferRow
              key={row.offer.id}
              offer={row.offer}
              claimingId={props.claimingId}
              onClaim={props.onClaim}
              installedApp={props.installedApp}
            />
          ),
        )}
      </ul>
    </section>
  );
}

/**
 * An offer not yet claimed: its grant, and Claim, or a disabled "Sold out"
 * once every seat is taken.
 */
function ClaimableOfferRow(props: {
  readonly offer: CreditOffer;
  readonly claimingId: string | null;
  readonly onClaim: (campaignId: string) => void;
  readonly installedApp: boolean;
}): ReactNode {
  const { offer, installedApp } = props;
  const soldOut = offer.claim === "sold_out";
  return (
    <li
      className="col-span-full grid grid-cols-subgrid items-center gap-y-2 py-4"
      data-testid="credits-offer-row"
    >
      <div className="row-span-2 self-start @md:row-span-1 @md:self-center">
        <p
          className={cn(
            "text-title-sm font-semibold tabular-nums",
            soldOut ? "text-muted-foreground" : "text-foreground",
          )}
          data-testid="credits-offer-remaining"
        >
          {formatAmount(offer.grantCredits, installedApp)}
        </p>
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="text-ui-sm font-medium text-foreground">{offer.name}</p>
        {offer.description === null ? null : (
          <p className="text-ui-xs text-muted-foreground">
            {offer.description}
          </p>
        )}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-3 @md:col-start-3 @md:justify-self-end">
        <CreditOfferTimeLeft endsAt={offer.endsAt} />
        <Button
          type="button"
          size="sm"
          variant={soldOut ? "secondary" : "default"}
          disabled={soldOut || props.claimingId !== null}
          onClick={() => props.onClaim(offer.id)}
          data-testid="credits-offer-claim"
        >
          {props.claimingId === offer.id ? <MutedAgentSpinner /> : null}
          {soldOut ? CREDITS_PAGE.offerSoldOut : CREDITS_PAGE.offerClaim}
        </Button>
      </div>
    </li>
  );
}

function CreditOfferRow(props: {
  readonly offer: AuthenticatedUserCampaignCredit;
  readonly installedApp: boolean;
}): ReactNode {
  const { offer, installedApp } = props;
  const leftPercent =
    offer.grantCredits > 0
      ? Math.max(
          0,
          Math.min(100, (offer.remainingCredits / offer.grantCredits) * 100),
        )
      : 0;
  return (
    <li
      className="col-span-full grid grid-cols-subgrid items-center gap-y-2 py-4"
      data-testid="credits-offer-row"
    >
      <div className="row-span-2 self-start @md:row-span-1 @md:self-center">
        <p
          className="text-title-sm font-semibold tabular-nums text-foreground"
          data-testid="credits-offer-remaining"
        >
          {formatAmount(offer.remainingCredits, installedApp)}
        </p>
        <p
          className="text-ui-xs tabular-nums text-muted-foreground"
          data-testid="credits-offer-grant"
        >
          {CREDITS_PAGE.offerGrant(
            formatAmount(offer.grantCredits, installedApp),
          )}
        </p>
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="text-ui-sm font-medium text-foreground">{offer.name}</p>
        {offer.description === null ? null : (
          <p className="text-ui-xs text-muted-foreground">
            {offer.description}
          </p>
        )}
      </div>
      <div className="col-start-2 @md:col-start-3 @md:justify-self-end">
        <CreditOfferTimeLeft endsAt={offer.endsAt} />
      </div>
      {/* Decoration for the two figures above, which already say it. */}
      <div
        aria-hidden="true"
        className="col-span-full h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${String(leftPercent)}%` }}
        />
      </div>
    </li>
  );
}

/** "5 days left", with the exact end on hover or focus. */
function CreditOfferTimeLeft(props: { readonly endsAt: string }): ReactNode {
  const now = useSampledNow();
  const end = Date.parse(props.endsAt);
  return (
    <TooltipWrapper
      label={CREDITS_PAGE.offerEnds(offerEndFormat.format(end))}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* A button only so a keyboard can reach it and open the exact end. */}
      <button
        type="button"
        className="inline-flex cursor-help items-center gap-1 whitespace-nowrap rounded-sm text-ui-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid="credits-offer-time-left"
      >
        <Timer aria-hidden className="size-3.5" />
        <time dateTime={props.endsAt}>
          {CREDITS_PAGE.offerTimeLeft(formatDistanceStrict(end, now))}
        </time>
      </button>
    </TooltipWrapper>
  );
}

function AddCreditsButton(props: {
  readonly billingUrl: string;
  readonly openLink: OpenLink;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="credits-add-link"
      onClick={(event) => {
        void (async () => {
          try {
            await props.openLink(props.billingUrl, "account", event);
          } catch (error) {
            ignoreError(error);
          }
        })();
      }}
      className="inline-flex w-fit items-center gap-1.5 rounded px-1 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      Add credits
      <ExternalLink className="size-3" />
    </button>
  );
}
