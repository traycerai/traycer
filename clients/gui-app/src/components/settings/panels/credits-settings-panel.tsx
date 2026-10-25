/**
 * Account ▸ Credits. E4 mounts this under the `credits` row. The balance is
 * the signed-in user's remaining credits, $0.00 included (a user with no
 * subscription has none); `Add credits ↗` opens the dashboard billing page;
 * the hourly line is the staged sandbox's awake price, or the default shape
 * when none is staged.
 */
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { CREDITS_PAGE } from "@/components/settings/panels/credits-settings.definitions";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { usePlatformBillingUrl } from "@/hooks/auth/use-platform-billing-url";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  formatCredits,
  formatCreditsPlain,
} from "@/lib/auth/traycer-subscription-content";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenLink, type OpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { sandboxBalanceMc } from "@/lib/sandboxes/sandbox-balance";
import {
  formatAwakeHourlyPrice,
  sandboxHourlyQuote,
  type SandboxHourlyQuote,
} from "@/lib/sandboxes/sandbox-hourly-quote";
import { useStagedSandboxInThisWindow } from "@/lib/sandboxes/staged-sandbox-in-window";

const MC_PER_CREDIT = 1000;

export function CreditsSettingsPanel(): ReactNode {
  const query = useAuthUser();
  useRefreshCreditsOnTraycerTurn();
  const catalogue = useSandboxCatalogue(true);
  const staged = useStagedSandboxInThisWindow();
  const billingUrl = usePlatformBillingUrl();
  const openLink = useOpenLink();
  const installedApp = isMobileApp();

  const user = query.data ?? null;
  const remainingMc = sandboxBalanceMc(user);
  const quote = sandboxHourlyQuote(catalogue.data, staged);

  return (
    <SettingsPanelShell
      title={CREDITS_PAGE.label}
      description={CREDITS_PAGE.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
      headerAction={
        <RefreshIconButton
          onRefresh={async () => {
            await query.refetch();
          }}
          label="Refresh credits"
          refreshing={query.isFetching}
        />
      }
    >
      <CreditsBody
        pending={query.isPending}
        error={query.isError}
        onRetry={() => void query.refetch()}
        remainingMc={remainingMc}
        quote={quote}
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
  readonly quote: SandboxHourlyQuote | null;
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
    props.installedApp
      ? `${formatCreditsPlain(remainingCredits)} credits`
      : formatCredits(remainingCredits),
  );
  return (
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
      {props.quote !== null ? (
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="credits-hourly-price"
        >
          {formatAwakeHourlyPrice(props.quote)}
        </p>
      ) : null}
      {props.installedApp ? null : (
        <AddCreditsButton
          billingUrl={props.billingUrl}
          openLink={props.openLink}
        />
      )}
    </div>
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
