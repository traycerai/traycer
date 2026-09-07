/** Bespoke per-provider rate-limit views for the Settings > Providers card (`provider-rate-limit-section.tsx`). */
import type { ReactNode } from "react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import {
  classifyProviderRateLimitWindow,
  isOpenCodeGoRateLimitWindowLimited,
} from "@traycer/protocol/host/rate-limit";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { Badge } from "@/components/ui/badge";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { MeterRow } from "@/components/settings/panels/traycer-subscription-views";
import {
  OpenCodeGoManageLink,
  OpenModelProvidersButton,
} from "@/components/settings/panels/opencode-go-actions";
import { contextUsageTone } from "@/components/chat/context-usage";
import { creditUsageSeverity } from "@/lib/rate-limits/window-severity";
import {
  formatUnavailableReason,
  resolveProviderRateLimitViewState,
  titleCaseFromToken,
} from "@/lib/provider-rate-limit-content";
import {
  formatResetFullDateTime,
  useIsFarReset,
  useRelativeTimestamp,
  useResetCountdown,
  useSampledNow,
} from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  selectEarliestExpiringCodexResetCredit,
  visibleCodexResetCredits,
  type CodexResetCredit,
  type CodexResetCreditActionRenderer,
  type CodexResetCredits,
} from "@/components/settings/panels/codex-reset-credit-model";

/** Every window/bar draws identically across all three - the Settings › Providers card and both popover
 * surfaces share one row renderer (`RateLimitWindowRow`), so they can never visually drift (feedback. */
export type RateLimitViewVariant =
  | "settings"
  | "popover-detail"
  | "popover-overview";

/** Fields the single-provider detail keeps but Overview drops are gated on `!isOverviewVariant(variant)`. */
function isOverviewVariant(variant: RateLimitViewVariant): boolean {
  return variant === "popover-overview";
}

/** The query's cached `data` is the `host.getRateLimitUsage` provider-pull envelope
 * (`ProviderRateLimitEnvelope`). */
export interface ProviderRateLimitQueryState {
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly envelope: ProviderRateLimitEnvelope | null | undefined;
}

type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;
type CodexRateLimits = Extract<ProviderRateLimits, { provider: "codex" }>;
type ClaudeRateLimits = Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
>;
type OpenRouterRateLimits = Extract<
  ProviderRateLimits,
  { provider: "openrouter" }
>;
type KiloCodeRateLimits = Extract<ProviderRateLimits, { provider: "kilocode" }>;
type GrokRateLimits = Extract<ProviderRateLimits, { provider: "grok" }>;
type CursorRateLimits = Extract<ProviderRateLimits, { provider: "cursor" }>;
type HuggingFaceRateLimits = Extract<
  ProviderRateLimits,
  { provider: "huggingface" }
>;
type OpenCodeRateLimits = Extract<
  ProviderRateLimits,
  { provider: "opencode"; available: true }
>;

const MINUTES_PER_HOUR = 60;
// A manual reset expiring inside this window is tinted `text-destructive` in the
// Settings list - use it or lose it.
const RESET_CREDIT_WARNING_MS = 48 * 60 * 60 * 1000;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MINUTES_PER_SESSION = MINUTES_PER_HOUR * 5;
const RESET_TIMESTAMP_PLAUSIBLE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** A window's label from its real duration, not a hardcoded "5-hour"/"Weekly" (Core Flows: "if the provider
 * tells us the window is 6 hours, that's what's shown"). */
function formatWindowDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "Usage";
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes === MINUTES_PER_SESSION) return "Current session";
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

function formatProviderCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatClaudeExtraUsageCents(value: number): string {
  return formatProviderCurrency(value / 100);
}

function RelativeResetLine({
  resetsAt,
  tone,
}: {
  readonly resetsAt: number;
  readonly tone: string;
}): ReactNode {
  const countdown = useResetCountdown(resetsAt);
  if (countdown === null) return null;
  return <span className={cn("text-ui-xs", tone)}>Resets in {countdown}</span>;
}

/** Exact calendar date/time ("Resets Sat, Jul 18, 2026, 3:35 AM") - for weekly-scale windows, where a relative
 * countdown ("Resets in 3d") is too coarse to act on. Pure, no clock subscription. */
function ExactResetLine({
  resetsAt,
  tone,
}: {
  readonly resetsAt: number;
  readonly tone: string;
}): ReactNode {
  return (
    <span className={cn("text-ui-xs", tone)}>
      Resets {formatResetFullDateTime(resetsAt)}
    </span>
  );
}

/** Dispatches to `RelativeResetLine` or `ExactResetLine` by whether `resetsAt` is far enough away
 * (`useIsFarReset`. */
function ResetLine({
  resetsAt,
  tone,
}: {
  readonly resetsAt: number | null;
  readonly tone: string;
}): ReactNode {
  const now = useSampledNow();
  const displayResetsAt =
    resetsAt !== null && plausibleResetTimestamp(resetsAt, now)
      ? resetsAt
      : null;
  const isFar = useIsFarReset(displayResetsAt);
  if (displayResetsAt === null) return null;
  return isFar ? (
    <ExactResetLine resetsAt={displayResetsAt} tone={tone} />
  ) : (
    <RelativeResetLine resetsAt={displayResetsAt} tone={tone} />
  );
}

function plausibleResetTimestamp(resetsAt: number, now: number): boolean {
  return (
    resetsAt >= now - RESET_TIMESTAMP_PLAUSIBLE_WINDOW_MS &&
    resetsAt <= now + RESET_TIMESTAMP_PLAUSIBLE_WINDOW_MS
  );
}

/** `tone` is left to `MeterRow`'s own wrapping span (this slot never overrides it), unlike
 * `CodexSpendControlRow`'s reset line, which needs its own severity-driven tone outside a `MeterRow`. */
function WindowMeterDetail({
  resetsAt,
  usedPercent,
}: {
  readonly resetsAt: number | null;
  readonly usedPercent: number;
}): ReactNode {
  const percent = Math.round(Math.min(100, Math.max(0, usedPercent)));
  return (
    <span className="flex items-center gap-1">
      <span>{percent}% used</span>
      {resetsAt !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <ResetLine resetsAt={resetsAt} tone="" />
        </>
      ) : null}
    </span>
  );
}

/** A single window row, shared identically by the Settings card and both popover surfaces so they can never
 * visually drift. */
function RateLimitWindowRow({
  label,
  window,
}: {
  readonly label: string;
  readonly window: ProviderRateLimitWindow | null;
}): ReactNode {
  if (window === null) return null;
  return (
    <MeterRow
      label={label}
      usedPercent={window.usedPercent}
      severity={classifyProviderRateLimitWindow(window)}
      detail={
        <WindowMeterDetail
          resetsAt={window.resetsAt}
          usedPercent={window.usedPercent}
        />
      }
    />
  );
}

/** A window row whose label is composed from the window's real duration (`formatWindowDuration`) plus, where a
 * provider distinguishes otherwise same-duration windows. */
// Split out to keep `ProviderWindowRow` free of a nested ternary.
function windowBaseLabel(
  namePrefix: string | null,
  durationMinutes: number | null,
  duration: string,
): string {
  if (namePrefix === null) return duration;
  if (durationMinutes === null) return namePrefix;
  return `${namePrefix} · ${duration}`;
}

function ProviderWindowRow({
  window,
  namePrefix,
  qualifier,
}: {
  readonly window: ProviderRateLimitWindow | null;
  readonly namePrefix: string | null;
  readonly qualifier: string | null;
}): ReactNode {
  if (window === null) return null;
  const duration = formatWindowDuration(window.durationMinutes);
  const base = windowBaseLabel(namePrefix, window.durationMinutes, duration);
  const label = qualifier !== null ? `${base} (${qualifier})` : base;
  return <RateLimitWindowRow label={label} window={window} />;
}

/** A neutral labeled number (no bar, no severity color) - for values with no computable "% of limit" (Core
 * Flows: "Windows without a percentage"), e.g. OpenRouter's spend/credits and Kilo Code's balance. */
function ProviderNumberRow({
  label,
  value,
  format,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly format: (value: number) => string;
}): ReactNode {
  if (value === null) return null;
  return (
    <div className="flex items-center justify-between text-ui-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-ui-xs text-foreground">
        {format(value)}
      </span>
    </div>
  );
}

/** The string analogue of `ProviderNumberRow`: a neutral labeled value (no bar, no severity color) for provider
 * fields that are already display strings - a plan tier, a formatted date range. */
function ProviderTextRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): ReactNode {
  if (value === null) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-ui-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">
        {value}
      </span>
    </div>
  );
}

// Codex's `RateLimitReachedType` enum (host `harnesses/codex/protocol`) - lowercase tokens on the wire, so the
// badge needs a display map rather than showing the raw value.
const CODEX_RATE_LIMIT_REACHED_LABELS: Record<string, string> = {
  rate_limit_reached: "Usage limit reached",
  workspace_owner_credits_depleted: "Workspace credits depleted",
  workspace_member_credits_depleted: "Workspace credits depleted",
  workspace_owner_usage_limit_reached: "Workspace usage limit reached",
  workspace_member_usage_limit_reached: "Workspace usage limit reached",
};

function formatRateLimitReachedType(value: string): string {
  return CODEX_RATE_LIMIT_REACHED_LABELS[value] ?? titleCaseFromToken(value);
}

/** `null` groups are dropped before dividers are placed, so a divider never renders before the first visible
 * group or after the last. */
function RateLimitGroupStack({
  groups,
}: {
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly node: ReactNode;
  }>;
}): ReactNode {
  const rendered = groups.filter((group) => group.node !== null);
  return (
    <div className="flex flex-col gap-3">
      {rendered.map((group, index) => (
        <div key={group.key} className="flex flex-col gap-3">
          {index > 0 ? <div aria-hidden className="h-px bg-border/70" /> : null}
          {group.node}
        </div>
      ))}
    </div>
  );
}

export function CodexRateLimitView({
  data,
  variant,
}: {
  readonly data: CodexRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  return (
    <CodexRateLimitViewContent
      data={data}
      variant={variant}
      resetAction={null}
    />
  );
}

function CodexRateLimitViewContent({
  data,
  variant,
  resetAction,
}: {
  readonly data: CodexRateLimits;
  readonly variant: RateLimitViewVariant;
  readonly resetAction: CodexResetCreditActionRenderer | null;
}): ReactNode {
  // Overview keeps only the primary/secondary (5h/Weekly) windows; the badge, credits, per-model extraWindows,
  // spend control, and reset credits are single-provider-tab detail (`!isOverviewVariant`).
  const overview = isOverviewVariant(variant);

  const globalLimits: ReactNode = (
    <div className="flex flex-col gap-3">
      <ProviderWindowRow
        window={data.primary}
        namePrefix={null}
        qualifier={null}
      />
      <ProviderWindowRow
        window={data.secondary}
        namePrefix={null}
        qualifier={null}
      />
    </div>
  );

  // Each per-model sub-limit becomes its own labeled window row (Core Flows:
  // "no separate UI concept needed"), named by its `limitName`.
  const perModelLimits: ReactNode =
    !overview && data.extraWindows.length > 0 ? (
      <div className="flex flex-col gap-3">
        {data.extraWindows.map((extraWindow) => (
          <div key={extraWindow.limitId} className="flex flex-col gap-3">
            <ProviderWindowRow
              window={extraWindow.primary}
              namePrefix={extraWindow.limitName ?? extraWindow.limitId}
              qualifier={null}
            />
            <ProviderWindowRow
              window={extraWindow.secondary}
              namePrefix={extraWindow.limitName ?? extraWindow.limitId}
              qualifier={null}
            />
          </div>
        ))}
      </div>
    ) : null;

  const credits: ReactNode =
    !overview && (data.credits !== null || data.individualLimit !== null) ? (
      <div className="flex flex-col gap-3">
        {data.credits !== null ? (
          <CodexCreditsRow credits={data.credits} />
        ) : null}
        {data.individualLimit !== null ? (
          <CodexSpendControlRow limit={data.individualLimit} />
        ) : null}
      </div>
    ) : null;

  const manualResets: ReactNode =
    !overview && data.resetCredits !== null ? (
      <CodexResetCreditsRow
        resetCredits={data.resetCredits}
        resetAction={resetAction}
        variant={variant}
      />
    ) : null;

  // Overview never gets here with more than `globalLimits`; the divider
  // placement rules live on `RateLimitGroupStack`.
  return (
    <div className="flex flex-col gap-3">
      {!overview && data.rateLimitReachedType !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">
            {formatRateLimitReachedType(data.rateLimitReachedType)}
          </Badge>
        </div>
      ) : null}
      <RateLimitGroupStack
        groups={[
          { key: "global", node: globalLimits },
          { key: "per-model", node: perModelLimits },
          { key: "credits", node: credits },
          { key: "manual-resets", node: manualResets },
        ]}
      />
    </div>
  );
}

/** Which surface a credit line paints on. */
type CodexResetCreditTone = "panel" | "tooltip";

function CodexResetCreditExpiry({
  credit,
  tone,
}: {
  readonly credit: CodexResetCredit;
  readonly tone: CodexResetCreditTone;
}): ReactNode {
  const now = useSampledNow();
  const countdown = useResetCountdown(credit.expiresAt);
  const farExpiry = useIsFarReset(credit.expiresAt);
  if (credit.expiresAt === null) return <span>No expiry</span>;
  if (!plausibleResetTimestamp(credit.expiresAt, now)) {
    return <span>Expiry unavailable</span>;
  }
  if (credit.expiresAt <= now) return <span>Expired</span>;
  const warning =
    tone === "panel" && credit.expiresAt - now <= RESET_CREDIT_WARNING_MS;
  return (
    <span className={cn(warning && "text-destructive")}>
      {farExpiry
        ? `Expires ${formatResetFullDateTime(credit.expiresAt)}`
        : `Expires in ${countdown ?? "less than a minute"}`}
    </span>
  );
}

function CodexResetCreditDetail({
  credit,
  tone,
}: {
  readonly credit: CodexResetCredit;
  readonly tone: CodexResetCreditTone;
}): ReactNode {
  if (credit.status === "redeeming") {
    return (
      <span
        className={cn(
          "flex items-center gap-1",
          tone === "panel" && "text-muted-foreground",
        )}
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Redeeming
      </span>
    );
  }
  return <CodexResetCreditExpiry credit={credit} tone={tone} />;
}

/** Shared by both surfaces so their wording and ordering can't drift. */
function CodexResetCreditLines({
  credits,
  omittedCount,
  tone,
}: {
  readonly credits: ReadonlyArray<CodexResetCredit>;
  readonly omittedCount: number;
  readonly tone: CodexResetCreditTone;
}): ReactNode {
  const panel = tone === "panel";
  return (
    <div className={cn("flex flex-col text-ui-xs", panel ? "gap-2" : "gap-1")}>
      {credits.map((credit) => (
        <div
          key={credit.id}
          className="flex items-center justify-between gap-3"
        >
          <span
            className={cn("min-w-0 truncate", panel && "text-muted-foreground")}
          >
            {credit.title ?? "Manual reset"}
          </span>
          <span
            className={cn("shrink-0 font-mono", panel && "text-foreground")}
          >
            <CodexResetCreditDetail credit={credit} tone={tone} />
          </span>
        </div>
      ))}
      {omittedCount > 0 ? (
        <span className={cn(panel && "text-muted-foreground")}>
          +{omittedCount} more not shown
        </span>
      ) : null}
    </div>
  );
}

function CodexResetCreditsRow({
  resetCredits,
  resetAction,
  variant,
}: {
  readonly resetCredits: CodexResetCredits;
  readonly resetAction: CodexResetCreditActionRenderer | null;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  const now = useSampledNow();
  const credits = resetCredits.credits;
  const visibleCredits =
    credits === null ? [] : visibleCodexResetCredits(credits);
  const selectedCredit =
    credits === null
      ? null
      : selectEarliestExpiringCodexResetCredit(credits, now);
  const omittedCount =
    credits !== null && credits.length > 0
      ? Math.max(0, resetCredits.availableCount - credits.length)
      : 0;
  const action =
    resetCredits.availableCount > 0 && resetAction !== null
      ? resetAction({
          selectedCredit,
          availableCount: resetCredits.availableCount,
        })
      : null;
  // A count-only response (older hosts send no `credits` array) has nothing to
  // list or reveal, so neither surface offers an affordance for it.
  const hasDetail = visibleCredits.length > 0;
  const listed = variant === "settings" && hasDetail;
  const hoverable = !listed && hasDetail;
  const countText = `${resetCredits.availableCount} available`;
  return (
    <div className="flex flex-col gap-2 text-ui-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground">Manual resets</span>
        <span className="flex items-center gap-2">
          {hoverable ? (
            <Tooltip>
              {/* A real `<button>`, not a `span` + `tabIndex`. */}
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="appearance-none bg-transparent p-0 font-mono text-ui-xs text-foreground cursor-help"
                >
                  {countText}
                </button>
              </TooltipTrigger>
              {/* `max-w-sm`, not the shadcn default `max-w-xs`: a title plus a mono full-date expiry ("Full reset. */}
              <TooltipContent
                side="top"
                align="end"
                sideOffset={6}
                className="max-w-sm"
              >
                <CodexResetCreditLines
                  credits={visibleCredits}
                  omittedCount={omittedCount}
                  tone="tooltip"
                />
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-mono text-ui-xs text-foreground">
              {countText}
            </span>
          )}
          {action}
        </span>
      </div>
      {listed ? (
        <div className="pl-3">
          <CodexResetCreditLines
            credits={visibleCredits}
            omittedCount={omittedCount}
            tone="panel"
          />
        </div>
      ) : null}
    </div>
  );
}

function CodexCreditsRow({
  credits,
}: {
  readonly credits: NonNullable<CodexRateLimits["credits"]>;
}): ReactNode {
  const label = credits.unlimited
    ? "Unlimited"
    : (credits.balance ?? (credits.hasCredits ? "Available" : "None"));
  return (
    <div className="flex items-center justify-between text-ui-sm">
      <span className="text-muted-foreground">Credits</span>
      <span className="font-mono text-ui-xs text-foreground">{label}</span>
    </div>
  );
}

function CodexSpendControlRow({
  limit,
}: {
  readonly limit: NonNullable<CodexRateLimits["individualLimit"]>;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-muted-foreground">Spend limit</span>
        <span className="font-mono text-ui-xs text-foreground">
          {limit.used} / {limit.limit}
        </span>
      </div>
      <div className="flex justify-end">
        <ResetLine
          resetsAt={limit.resetsAt}
          tone={contextUsageTone(limit.remainingPercent)}
        />
      </div>
    </div>
  );
}

export function ClaudeRateLimitView({
  data,
  variant,
}: {
  readonly data: ClaudeRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps only the 5h (`fiveHour`) and Weekly (`sevenDay`) windows; the Opus/Sonnet weekly buckets,
  // per-model rows, and extra-usage bar are single-provider-tab detail.
  const overview = isOverviewVariant(variant);

  const globalLimits: ReactNode = (
    <div className="flex flex-col gap-3">
      <ProviderWindowRow
        window={data.fiveHour}
        namePrefix={null}
        qualifier={null}
      />
      <ProviderWindowRow
        window={data.sevenDay}
        namePrefix={null}
        qualifier={null}
      />
      {!overview ? (
        <ProviderWindowRow
          window={data.sevenDayOpus}
          namePrefix={null}
          qualifier="Opus"
        />
      ) : null}
      {!overview ? (
        <ProviderWindowRow
          window={data.sevenDaySonnet}
          namePrefix={null}
          qualifier="Sonnet"
        />
      ) : null}
    </div>
  );

  // Each model-scoped window is its own labeled row.
  const perModelLimits: ReactNode =
    !overview && data.modelScoped.length > 0 ? (
      <div className="flex flex-col gap-3">
        {data.modelScoped.map((entry) => (
          // `displayName` alone isn't guaranteed unique across entries - fold in `resetsAt` (an array index would defeat
          // reconciliation on reorder/filter, and ESLint's `no-array-index-key` disallows it outright).
          <RateLimitWindowRow
            key={`${entry.displayName}-${entry.resetsAt}`}
            label={entry.displayName}
            window={entry}
          />
        ))}
      </div>
    ) : null;

  const extraUsage: ReactNode =
    !overview && data.extraUsage !== null && data.extraUsage.isEnabled ? (
      <ClaudeExtraUsageRow extraUsage={data.extraUsage} />
    ) : null;

  // Overview never gets here with more than `globalLimits`; the divider
  // placement rules live on `RateLimitGroupStack`.
  return (
    <RateLimitGroupStack
      groups={[
        { key: "global", node: globalLimits },
        { key: "per-model", node: perModelLimits },
        { key: "extra-usage", node: extraUsage },
      ]}
    />
  );
}

function ClaudeExtraUsageRow({
  extraUsage,
}: {
  readonly extraUsage: NonNullable<ClaudeRateLimits["extraUsage"]>;
}): ReactNode {
  // `utilization` is only ever shown as raw supplementary text.
  if (extraUsage.monthlyLimit !== null && extraUsage.usedCredits !== null) {
    const usedPercent =
      extraUsage.monthlyLimit > 0
        ? (extraUsage.usedCredits / extraUsage.monthlyLimit) * 100
        : 0;
    return (
      <MeterRow
        label="Extra usage"
        usedPercent={usedPercent}
        severity={creditUsageSeverity(usedPercent)}
        detail={`${formatClaudeExtraUsageCents(extraUsage.usedCredits)} / ${formatClaudeExtraUsageCents(extraUsage.monthlyLimit)}`}
      />
    );
  }
  if (extraUsage.utilization !== null) {
    return (
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-muted-foreground">Extra usage</span>
        <span className="font-mono text-ui-xs text-foreground">
          {extraUsage.utilization}
        </span>
      </div>
    );
  }
  return null;
}

/** OpenRouter's usage detail: a request/credit bar when a hard `limit` exists, plus its uncapped
 * spend/credit/balance figures as plain neutral rows (Core Flows: "Windows without a percentage". */
export function OpenRouterRateLimitView({
  data,
  variant,
}: {
  readonly data: OpenRouterRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps only the Credits bar and Balance; the total-credit/usage and
  // per-period spend figures are single-provider-tab detail.
  const overview = isOverviewVariant(variant);
  return (
    <div className="flex flex-col gap-3">
      <OpenRouterCreditBar
        limit={data.limit}
        limitRemaining={data.limitRemaining}
      />
      <ProviderNumberRow
        label="Balance"
        value={data.balance}
        format={formatProviderCurrency}
      />
      {!overview ? (
        <>
          <ProviderNumberRow
            label="Total credits"
            value={data.totalCredits}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Total usage"
            value={data.totalUsage}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Spent today"
            value={data.dailySpend}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Spent this week"
            value={data.weeklySpend}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Spent this month"
            value={data.monthlySpend}
            format={formatProviderCurrency}
          />
        </>
      ) : null}
    </div>
  );
}

// Only OpenRouter's `limit`/`limitRemaining` pair yields a computable "% of limit"; the derived percentage
// matches the header glyph's exact `((limit.
function OpenRouterCreditBar({
  limit,
  limitRemaining,
}: {
  readonly limit: number | null;
  readonly limitRemaining: number | null;
}): ReactNode {
  if (limit === null || limitRemaining === null || limit <= 0) return null;
  const consumed = Math.max(0, limit - limitRemaining);
  const usedPercent = (consumed / limit) * 100;
  return (
    <MeterRow
      label="Credits"
      usedPercent={usedPercent}
      severity={creditUsageSeverity(usedPercent)}
      detail={`${formatProviderCurrency(consumed)} / ${formatProviderCurrency(limit)}`}
    />
  );
}

/** In the second case there is no denominator, so no bar and no fabricated "0 of unknown" row; spend stands
 * alone (Core Flows: "Windows without a percentage"). */
export function HuggingFaceRateLimitView({
  data,
  variant,
}: {
  readonly data: HuggingFaceRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps the credits bar and the headline remaining/spent figure; the spend limit, request count and
  // billing period are single-provider-tab detail.
  const overview = isOverviewVariant(variant);
  return (
    <div className="flex flex-col gap-3">
      <HuggingFaceCreditBar
        includedUsd={data.includedUsd}
        usedUsd={data.usedUsd}
      />
      {data.includedUsd === null ? (
        <ProviderNumberRow
          label="Spent this period"
          value={data.usedUsd}
          format={formatProviderCurrency}
        />
      ) : (
        <ProviderNumberRow
          label="Included credits left"
          value={data.remainingIncludedUsd}
          format={formatProviderCurrency}
        />
      )}
      {!overview ? (
        <>
          {data.includedUsd === null ? null : (
            <ProviderNumberRow
              label="Included credits"
              value={data.includedUsd}
              format={formatProviderCurrency}
            />
          )}
          {data.includedUsd === null ? null : (
            <ProviderNumberRow
              label="Used this period"
              value={data.usedUsd}
              format={formatProviderCurrency}
            />
          )}
          <ProviderNumberRow
            label="Spend limit"
            value={data.limitUsd}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Spend limit left"
            value={data.remainingLimitUsd}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="Requests"
            value={data.numRequests}
            format={(value) => value.toLocaleString()}
          />
          <HuggingFacePeriodRow
            periodStart={data.periodStart}
            periodEnd={data.periodEnd}
          />
        </>
      ) : null}
    </div>
  );
}

// Rendered only when both bounds are present and parseable: the endpoint is schema-less, so an unparseable
// value degrades to no row rather than to "Invalid Date".
function HuggingFacePeriodRow({
  periodStart,
  periodEnd,
}: {
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}): ReactNode {
  if (periodStart === null || periodEnd === null) return null;
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const format = (value: Date): string =>
    value.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  return (
    <div className="flex items-center justify-between text-ui-sm">
      <span className="text-muted-foreground">Billing period</span>
      <span className="font-medium text-foreground">{`${format(start)} - ${format(end)}`}</span>
    </div>
  );
}

// `usedUsd` can exceed the allowance once an account spends past it, so the fill is clamped rather than
// allowed to overflow the meter.
function HuggingFaceCreditBar({
  includedUsd,
  usedUsd,
}: {
  readonly includedUsd: number | null;
  readonly usedUsd: number;
}): ReactNode {
  if (includedUsd === null || includedUsd <= 0) return null;
  const consumed = Math.min(Math.max(0, usedUsd), includedUsd);
  const usedPercent = (consumed / includedUsd) * 100;
  return (
    <MeterRow
      label="Included credits"
      usedPercent={usedPercent}
      severity={creditUsageSeverity(usedPercent)}
      detail={`${formatProviderCurrency(consumed)} / ${formatProviderCurrency(includedUsd)}`}
    />
  );
}

/** No computable percentage exists for Kilo Code, so it never renders a bar (Core Flows: "Windows without a
 * percentage"). */
export function KiloCodeRateLimitView({
  data,
  variant,
}: {
  readonly data: KiloCodeRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps only the credit balance; Kilo Pass state is
  // single-provider-tab detail.
  const overview = isOverviewVariant(variant);
  return (
    <div className="flex flex-col gap-3">
      <ProviderNumberRow
        label="Credit balance"
        value={data.creditBalance}
        format={formatProviderCurrency}
      />
      {!overview && data.passState !== null ? (
        <div className="flex items-center justify-between text-ui-sm">
          <span className="text-muted-foreground">Kilo Pass</span>
          <span className="font-mono text-ui-xs text-foreground">
            {titleCaseFromToken(data.passState)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function OpenCodeGoWindowRow({
  label,
  window,
  now,
}: {
  readonly label: string;
  readonly window: OpenCodeRateLimits["fiveHour"];
  readonly now: number;
}): ReactNode {
  return (
    <MeterRow
      label={label}
      usedPercent={window.usedPercent}
      severity={
        isOpenCodeGoRateLimitWindowLimited(window, now)
          ? "limited"
          : classifyProviderRateLimitWindow(window)
      }
      detail={
        <WindowMeterDetail
          resetsAt={window.resetsAt}
          usedPercent={window.usedPercent}
        />
      }
    />
  );
}

export function OpenCodeRateLimitView({
  data,
}: {
  readonly data: OpenCodeRateLimits;
}): ReactNode {
  const now = useSampledNow();
  const limited = [data.fiveHour, data.weekly, data.monthly].some((window) =>
    isOpenCodeGoRateLimitWindowLimited(window, now),
  );
  return (
    <div className="flex flex-col gap-3">
      {limited ? (
        <div className="flex flex-col items-start gap-1.5">
          <Badge variant="destructive">Go limit reached</Badge>
          <p className="text-ui-xs text-muted-foreground">
            Go quota is exhausted. Free models or Zen balance may still work.
          </p>
        </div>
      ) : null}
      <OpenCodeGoWindowRow label="5-hour" window={data.fiveHour} now={now} />
      <OpenCodeGoWindowRow label="Weekly" window={data.weekly} now={now} />
      <OpenCodeGoWindowRow label="Monthly" window={data.monthly} now={now} />
      <OpenCodeGoManageLink />
    </div>
  );
}

/** Only the last `_`-segment carries the cadence, so the leading `USAGE_PERIOD_TYPE_` scaffolding is dropped
 * before title-casing. */
function formatGrokPeriodLabel(
  periodType: string | null,
  durationMinutes: number | null,
): string {
  if (periodType !== null) {
    const parts = periodType.split("_").filter((part) => part.length > 0);
    if (parts.length > 0) return titleCaseFromToken(parts[parts.length - 1]);
  }
  return formatWindowDuration(durationMinutes);
}

/** Compact calendar date ("Jul 22, 2026") for a billing-period bound. */
function formatBillingRangeDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The billing period's start-end range ("Jul 22, 2026 - Jul 29, 2026"), shown in grok's unmeasured-period
 * fallback where there's no usage bar to carry a reset date. */
function formatBillingRange(
  periodStart: number | null,
  periodEnd: number | null,
): string | null {
  if (periodStart === null || periodEnd === null) return null;
  return `${formatBillingRangeDate(periodStart)} - ${formatBillingRangeDate(periodEnd)}`;
}

/** Surfacing the plan and the period dates keeps the card meaningful instead of blank. */
function GrokPeriodFallback({
  subscriptionTier,
  periodStart,
  periodEnd,
  variant,
}: {
  readonly subscriptionTier: string | null;
  readonly periodStart: number | null;
  readonly periodEnd: number | null;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  return (
    <>
      {variant !== "popover-detail" ? (
        <ProviderTextRow label="Plan" value={subscriptionTier} />
      ) : null}
      <ProviderTextRow
        label="Billing period"
        value={formatBillingRange(periodStart, periodEnd)}
      />
    </>
  );
}

/** Raw credit figures (prepaid balance, monthly limit, on-demand used/limit) render only where xAI actually
 * reported them - it omits fields freely by account type. */
export function GrokRateLimitView({
  data,
  variant,
}: {
  readonly data: GrokRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps only the period usage (bar or fallback) and the prepaid balance; the monthly limit and
  // on-demand figures are single-provider-tab detail, matching how OpenRouter/Kilo Code trim their Overview.
  const overview = isOverviewVariant(variant);
  return (
    <div className="flex flex-col gap-3">
      {data.period !== null ? (
        <RateLimitWindowRow
          label={formatGrokPeriodLabel(
            data.periodType,
            data.period.durationMinutes,
          )}
          window={data.period}
        />
      ) : (
        <GrokPeriodFallback
          subscriptionTier={data.subscriptionTier}
          periodStart={data.periodStart}
          periodEnd={data.periodEnd}
          variant={variant}
        />
      )}
      <ProviderNumberRow
        label="Prepaid balance"
        value={data.prepaidBalance}
        format={formatProviderCurrency}
      />
      {!overview ? (
        <>
          <ProviderNumberRow
            label="Monthly limit"
            value={data.monthlyLimit}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="On-demand used"
            value={data.onDemandUsed}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="On-demand limit"
            value={data.onDemandCap}
            format={formatProviderCurrency}
          />
        </>
      ) : null}
    </div>
  );
}

/** When neither bucket was reported the cycle dates still render, keeping the card meaningful rather than blank
 * - the same fallback grok uses. The dollars ride their own meter, not the bucket bars. */
export function CursorRateLimitView({
  data,
  variant,
}: {
  readonly data: CursorRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  const overview = isOverviewVariant(variant);
  return (
    <div className="flex flex-col gap-3">
      {data.cursorModels === null && data.otherModels === null ? (
        <ProviderTextRow
          label="Billing cycle"
          value={formatBillingRange(data.cycleStart, data.cycleEnd)}
        />
      ) : (
        <>
          {data.cursorModels !== null ? (
            <RateLimitWindowRow
              label="Cursor Models"
              window={data.cursorModels}
            />
          ) : null}
          {data.otherModels !== null ? (
            <RateLimitWindowRow
              label="Other Models"
              window={data.otherModels}
            />
          ) : null}
        </>
      )}
      <CursorIncludedUsageBar
        includedLimitUsd={data.includedLimitUsd}
        usedUsd={data.usedUsd}
      />
      <ProviderNumberRow
        label="Included usage left"
        // Once spend crosses the purchased allowance the wire's remaining may run negative; "-$12 left" is meaningless
        // to a reader, and the overflow already shows in the meter's detail and the bonus row.
        value={
          data.remainingUsd === null ? null : Math.max(0, data.remainingUsd)
        }
        format={formatProviderCurrency}
      />
      <ProviderNumberRow
        label="Bonus usage"
        value={data.bonusUsedUsd}
        format={formatProviderCurrency}
      />
      {!overview ? (
        <>
          {data.displayMessage !== null ? (
            <p className="text-ui-xs text-muted-foreground">
              {data.displayMessage}
            </p>
          ) : null}
          <ProviderNumberRow
            label="On-demand limit"
            value={data.onDemandLimitUsd}
            format={formatProviderCurrency}
          />
          <ProviderNumberRow
            label="On-demand used"
            value={data.onDemandUsedUsd}
            format={formatProviderCurrency}
          />
        </>
      ) : null}
    </div>
  );
}

// Deliberately not `creditUsageSeverity`, and never red: for the credit providers, exhausting the allowance
// means real billing, so red is earned.
function CursorIncludedUsageBar({
  includedLimitUsd,
  usedUsd,
}: {
  readonly includedLimitUsd: number | null;
  readonly usedUsd: number | null;
}): ReactNode {
  if (includedLimitUsd === null || includedLimitUsd <= 0 || usedUsd === null) {
    return null;
  }
  const usedPercent = (Math.max(0, usedUsd) / includedLimitUsd) * 100;
  return (
    <MeterRow
      label="Included usage"
      usedPercent={usedPercent}
      severity={usedPercent > 85 ? "running_low" : "healthy"}
      detail={`${formatProviderCurrency(Math.max(0, usedUsd))} / ${formatProviderCurrency(includedLimitUsd)}`}
    />
  );
}

export function ProviderRateLimitBody(
  props: ProviderRateLimitQueryState & {
    readonly codexResetAction: CodexResetCreditActionRenderer | null;
    readonly openModelProvidersAction: (() => void) | null;
  },
): ReactNode {
  const state = resolveProviderRateLimitViewState(props);
  // `isPending` alone stays `true` forever for a disabled query (e.g. a chat tab bound to an unreachable host,
  // where `useHostQuery` never enables).
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading usage limits
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn't load usage limits. Try refreshing.
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't load usage limits",
            message: null,
            code: null,
            source: "Provider usage limits",
          })}
          presentation="link"
          className="ml-1 h-auto p-0 text-current"
        />
      </div>
    );
  }
  if (state.kind === "empty") return null;
  const data = state.data;
  if (!data.available) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-ui-xs text-muted-foreground">
          Usage limits unavailable - {formatUnavailableReason(data.reason)}
        </p>
        {data.provider === "opencode" &&
        data.reason === "insufficient_permissions" &&
        props.openModelProvidersAction !== null ? (
          <OpenModelProvidersButton onClick={props.openModelProvidersAction} />
        ) : null}
      </div>
    );
  }
  const detail = (
    <ProviderRateLimitDetail
      data={data}
      variant="settings"
      codexResetAction={props.codexResetAction}
    />
  );
  // Fresh reading: render as-is. The Providers panel header already carries a
  // "Checked Xm ago" for provider status, so a healthy usage card needs no
  // second timestamp.
  if (!state.degraded) return detail;
  // Degraded: a retained last-known-good reading is being shown after the
  // latest poll failed. Surface the ORIGINAL update time plus a failed-refresh
  // note and dim the reading in place - the same treatment the header popover
  // gives this state, so the stale numbers can't be mistaken for fresh.
  return (
    <div className="flex flex-col gap-2">
      <StaleUsageRefreshNote
        lastGoodAt={state.lastGoodAt}
        degradedReason={state.degradedReason}
      />
      <div className="opacity-60">{detail}</div>
    </div>
  );
}

/** Show original `lastGoodAt` (never the failed attempt's time) plus the envelope reason, or "refresh failed" when the query threw. */
function StaleUsageRefreshNote({
  lastGoodAt,
  degradedReason,
}: {
  readonly lastGoodAt: number | null;
  readonly degradedReason: RateLimitUnavailableReason | null;
}): ReactNode {
  const ago = useRelativeTimestamp(lastGoodAt ?? 0);
  const note =
    degradedReason !== null
      ? formatUnavailableReason(degradedReason)
      : "refresh failed";
  return (
    <p className="text-ui-xs text-muted-foreground">
      {lastGoodAt !== null ? `Updated ${ago} · ${note}` : note}
    </p>
  );
}

/** Exhaustive over every `available: true` arm so a new provider fails the build here until it has a view. */
export function ProviderRateLimitDetail({
  data,
  variant,
  codexResetAction,
}: {
  readonly data: AvailableProviderRateLimits;
  readonly variant: RateLimitViewVariant;
  readonly codexResetAction: CodexResetCreditActionRenderer | null;
}): ReactNode {
  switch (data.provider) {
    case "codex":
      return (
        <CodexRateLimitViewContent
          data={data}
          variant={variant}
          resetAction={codexResetAction}
        />
      );
    case "claude-code":
      return <ClaudeRateLimitView data={data} variant={variant} />;
    // OpenRouter/Kilo Code report no usage *windows* (only credit/spend bars and
    // plain figures), so the settings/popover window distinction doesn't apply -
    // but `variant` still drives the Overview-vs-detail trim (Overview shows
    // only their balance/credit fields).
    case "openrouter":
      return <OpenRouterRateLimitView data={data} variant={variant} />;
    case "kilocode":
      return <KiloCodeRateLimitView data={data} variant={variant} />;
    // Grok reports no rolling usage *windows* either - only a synthesized
    // billing-period bar plus credit figures - so, like OpenRouter/Kilo Code,
    // `variant` drives just the Overview-vs-detail trim.
    case "grok":
      return <GrokRateLimitView data={data} variant={variant} />;
    // Hugging Face is a credit provider like OpenRouter/Kilo Code: the only
    // percentage it can report is against an included allowance, and accounts
    // without one render spend figures alone.
    case "huggingface":
      return <HuggingFaceRateLimitView data={data} variant={variant} />;
    case "opencode":
      return <OpenCodeRateLimitView data={data} />;
    // Cursor is windowed, not credit-shaped: its money fields back a real
    // billing-cycle percentage, so it renders a usage bar like grok rather than
    // the spend-only layout OpenRouter/Kilo Code/Hugging Face use.
    case "cursor":
      return <CursorRateLimitView data={data} variant={variant} />;
  }
}
