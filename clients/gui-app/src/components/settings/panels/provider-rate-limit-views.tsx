/**
 * Bespoke per-provider rate-limit views for the Settings > Providers card
 * (`provider-rate-limit-section.tsx`). Kept host/query-free - the card owns
 * its own host-scoped query + refresh wiring and hands this module plain
 * data, so the data-to-UI mapping lives in exactly one place.
 */
import type { ReactNode } from "react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import { Badge } from "@/components/ui/badge";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  MeterRow,
  UsageBar,
  type UsageBarTone,
} from "@/components/settings/panels/traycer-subscription-views";
import { contextUsageTone } from "@/components/chat/context-usage";
import {
  formatUnavailableReason,
  resolveProviderRateLimitViewState,
} from "@/lib/provider-rate-limit-content";
import { formatResetDateTime, useResetCountdown } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * Which surface a provider's detail is rendered on. Every window/bar draws
 * identically across all three - the Settings › Providers card and both
 * popover surfaces share one row renderer (`RateLimitWindowRow`), so they can
 * never visually drift (feedback: "different UX looks weird"). The only thing
 * this enum still drives is how much detail is shown:
 *
 * - `"settings"` / `"popover-detail"`: the provider's full detail (every
 *   window, credits, spend, reset credits, plan label, badges).
 * - `"popover-overview"`: the header popover's Overview tab - condensed to
 *   only the primary/secondary (5h/Weekly) windows plus credit/balance
 *   figures, dropping per-model `extraWindows`, reset credits, the
 *   rate-limit-reached badge, the plan/tier label, and per-provider spend
 *   controls, which stay in the single-provider tab.
 */
export type RateLimitViewVariant =
  "settings" | "popover-detail" | "popover-overview";

/**
 * The condensed Overview surface. Fields the single-provider detail keeps but
 * Overview drops are gated on `!isOverviewVariant(variant)`.
 */
function isOverviewVariant(variant: RateLimitViewVariant): boolean {
  return variant === "popover-overview";
}

/** Shared read of a provider rate-limit query, independent of host scope. */
export interface ProviderRateLimitQueryState {
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly providerRateLimits: ProviderRateLimits | null | undefined;
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

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/**
 * A window's label from its real duration, not a hardcoded "5-hour"/"Weekly"
 * (Core Flows: "if the provider tells us the window is 6 hours, that's what's
 * shown"). Every `ProviderRateLimitWindow` now carries `durationMinutes`, so
 * Codex's primary/secondary, Claude's fixed buckets, and Codex's per-model
 * `extraWindows` all label from the same formatter. `10080` (a 7-day window)
 * reads as "Weekly" rather than "7d" since that's the product's own wording;
 * anything else falls back to whole-day / whole-hour / raw-minute forms.
 */
function formatWindowDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "Usage";
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

/**
 * Whether a window's reset should show as an exact date/time rather than a
 * relative countdown: a day-or-longer window ("Resets in 3d" is too coarse to
 * act on). Generalizes the old per-bucket `weekly` flag from `durationMinutes`,
 * so a provider-reported 6-hour window stays a countdown while a weekly one
 * shows the date.
 */
function isWeeklyScale(minutes: number | null): boolean {
  return minutes !== null && minutes >= MINUTES_PER_DAY;
}

/** $-denominated value (credits, balance, spend). */
function formatProviderCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Rate-limit severity scale: >70% used is a warning, >90% is critical - used
 * only for the uncapped `UsageBar` bars (OpenRouter/Claude extra-usage) that
 * have no fixed 100% ceiling. Distinct from the shared `contextUsageTone` (a
 * LEFT/remaining-percent scale for the unrelated context-window chip, with
 * its own thresholds) - rate limits report a USED percentage and warrant
 * their own scale.
 */
function rateLimitSeverity(usedPercent: number): UsageBarTone | null {
  if (usedPercent > 90) return "critical";
  if (usedPercent > 70) return "warning";
  return null;
}

function usageBarTone(usedPercent: number): UsageBarTone | undefined {
  return rateLimitSeverity(usedPercent) ?? undefined;
}

/**
 * `snake_case`/lowercase-token → Title Case, for any enum value that isn't in
 * one of the display-name maps below (a forward-compat fallback for values
 * the host adds before this map is updated).
 */
function titleCaseFromToken(value: string): string {
  return value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

/** Relative countdown ("Resets in 4h 7m") - ticks on the shared 60s clock. */
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

/**
 * Exact date/time ("Resets Jul 4, 2026 12:10 AM") - for weekly-scale windows,
 * where a relative countdown ("Resets in 3d") is too coarse to act on. Pure,
 * no clock subscription.
 */
function ExactResetLine({
  resetsAt,
  tone,
}: {
  readonly resetsAt: number;
  readonly tone: string;
}): ReactNode {
  return (
    <span className={cn("text-ui-xs", tone)}>
      Resets {formatResetDateTime(resetsAt)}
    </span>
  );
}

/**
 * Dispatches to `RelativeResetLine` or `ExactResetLine` by `weekly` - a
 * static, per-window fact (which array field this is), never toggling for a
 * given row instance, so choosing the component at this level (rather than
 * conditionally calling one hook or the other inside a single component)
 * keeps both leaves' hook calls unconditional.
 */
function ResetLine({
  resetsAt,
  tone,
  weekly,
}: {
  readonly resetsAt: number | null;
  readonly tone: string;
  readonly weekly: boolean;
}): ReactNode {
  if (resetsAt === null) return null;
  return weekly ? (
    <ExactResetLine resetsAt={resetsAt} tone={tone} />
  ) : (
    <RelativeResetLine resetsAt={resetsAt} tone={tone} />
  );
}

/**
 * A single window row, shared identically by the Settings card and both
 * popover surfaces so they can never visually drift - delegates to the
 * shared `MeterRow` shell (`traycer-subscription-views.tsx`), passing the
 * reset line as its `subtext` slot: a relative countdown for a short window
 * ("Resets in 4h 7m"), an absolute date/time for a weekly-scale one ("Resets
 * Jul 11, 2026 (Tue) 3:35 AM") since "Resets in 3d" is too coarse to act on.
 * Choosing the leaf (`RelativeResetLine`/`ExactResetLine`) by `weekly` keeps
 * both leaves' hook calls unconditional. Renders nothing for a `null` window
 * so call sites can pass optional windows directly.
 */
function RateLimitWindowRow({
  label,
  window,
  weekly,
}: {
  readonly label: string;
  readonly window: ProviderRateLimitWindow | null;
  readonly weekly: boolean;
}): ReactNode {
  if (window === null) return null;
  return (
    <MeterRow
      label={label}
      usedPercent={window.usedPercent}
      subtext={
        <ResetLine
          resetsAt={window.resetsAt}
          tone="text-muted-foreground/70"
          weekly={weekly}
        />
      }
    />
  );
}

/**
 * A window row whose label is composed from the window's real duration
 * (`formatWindowDuration`) plus, where a provider distinguishes otherwise
 * same-duration windows, a name prefix (Codex's per-model limit name) or a
 * trailing qualifier (Claude's "(Opus)"/"(Sonnet)"). `weekly` is derived from
 * the duration too, so the whole "labels come from `durationMinutes`, not a
 * hardcoded 5-hour/Weekly" rule lives in one place. Renders nothing for a
 * `null` window so call sites can pass optional windows directly.
 */
// The label's base: a named window with a known duration reads "Name · 5h", a
// named window with no duration falls back to just the name, and an unnamed
// window is the bare duration. Split out to keep `ProviderWindowRow` free of a
// nested ternary.
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
  return (
    <RateLimitWindowRow
      label={label}
      window={window}
      weekly={isWeeklyScale(window.durationMinutes)}
    />
  );
}

/** A provider's plan/tier label (Core Flows: shown "where the provider reports one"). */
function ProviderPlanLabel({ label }: { readonly label: string }): ReactNode {
  return <div className="text-ui-xs text-muted-foreground">{label}</div>;
}

/**
 * A neutral labeled number (no bar, no severity color) - for values with no
 * computable "% of limit" (Core Flows: "Windows without a percentage"), e.g.
 * OpenRouter's spend/credits and Kilo Code's balance. Renders nothing when the
 * provider didn't report the value.
 */
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

// Codex's `RateLimitReachedType` enum (host `harnesses/codex/protocol`) -
// lowercase tokens on the wire, so the badge needs a display map rather than
// showing the raw value. Falls back to `titleCaseFromToken` for any value
// not listed here (forward-compat with a new value before this map updates).
const CODEX_RATE_LIMIT_REACHED_LABELS: Record<string, string> = {
  rate_limit_reached: "Rate limit reached",
  workspace_owner_credits_depleted: "Workspace credits depleted",
  workspace_member_credits_depleted: "Workspace credits depleted",
  workspace_owner_usage_limit_reached: "Workspace usage limit reached",
  workspace_member_usage_limit_reached: "Workspace usage limit reached",
};

function formatRateLimitReachedType(value: string): string {
  return CODEX_RATE_LIMIT_REACHED_LABELS[value] ?? titleCaseFromToken(value);
}

export function CodexRateLimitView({
  data,
  variant,
}: {
  readonly data: CodexRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  // Overview keeps only the primary/secondary (5h/Weekly) windows; the badge,
  // plan label, credits, per-model extraWindows, spend control, and reset
  // credits are single-provider-tab detail (`!isOverviewVariant`).
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
      <CodexResetCreditsRow resetCredits={data.resetCredits} />
    ) : null;

  // Groups are separated by a divider only where both the preceding and the
  // current group actually render (feedback: "show separator between global
  // limits, Spark limits, credits and manual resets" - it looked cluttered
  // without them). Overview never gets here with more than `globalLimits`.
  const groups: ReadonlyArray<{
    readonly key: string;
    readonly node: ReactNode;
  }> = [
    { key: "global", node: globalLimits },
    { key: "per-model", node: perModelLimits },
    { key: "credits", node: credits },
    { key: "manual-resets", node: manualResets },
  ].filter((group) => group.node !== null);

  return (
    <div className="flex flex-col gap-3">
      {!overview && data.rateLimitReachedType !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">
            {formatRateLimitReachedType(data.rateLimitReachedType)}
          </Badge>
        </div>
      ) : null}
      {/* Plan/tier label (wireframe: "Pro 5x" under the provider name) is the
          subscription tier - `planType` - not `limitName` (which is a rate-limit
          *bucket* id, already surfaced by each extra-window's own label). Shown
          only in the popover's single-provider detail tab; the Settings card
          deliberately omits any plan-ish line (its auth badge above already
          shows the plan), and Overview is condensed. */}
      {variant === "popover-detail" && data.planType !== null ? (
        <ProviderPlanLabel label={titleCaseFromToken(data.planType)} />
      ) : null}
      {groups.map((group, index) => (
        <div key={group.key} className="flex flex-col gap-3">
          {index > 0 ? <div aria-hidden className="h-px bg-border/70" /> : null}
          {group.node}
        </div>
      ))}
    </div>
  );
}

/**
 * Codex's periodic allowance of manual limit resets (Core Flows: "a manual
 * reset-credits block ... with a count"). The live `account/rateLimits/read`
 * shape is just `{ availableCount }` (no per-credit expiry array), so this is a
 * single count row.
 */
function CodexResetCreditsRow({
  resetCredits,
}: {
  readonly resetCredits: NonNullable<CodexRateLimits["resetCredits"]>;
}): ReactNode {
  return (
    <div className="flex items-center justify-between text-ui-sm">
      <span className="text-muted-foreground">Manual resets</span>
      <span className="font-mono text-ui-xs text-foreground">
        {resetCredits.availableCount} available
      </span>
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
          weekly={false}
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
  // Overview keeps only the 5h (`fiveHour`) and Weekly (`sevenDay`) windows; the
  // Opus/Sonnet weekly buckets, per-model rows, and extra-usage bar are
  // single-provider-tab detail.
  const overview = isOverviewVariant(variant);
  return (
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
      {!overview && data.modelScoped.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            Per-model
          </span>
          {data.modelScoped.map((entry) => (
            // `displayName` alone isn't guaranteed unique across entries -
            // fold in `resetsAt` (an array index would defeat reconciliation
            // on reorder/filter, and ESLint's `no-array-index-key` disallows
            // it outright).
            <RateLimitWindowRow
              key={`${entry.displayName}-${entry.resetsAt}`}
              label={entry.displayName}
              window={entry}
              weekly={isWeeklyScale(entry.durationMinutes)}
            />
          ))}
        </div>
      ) : null}
      {!overview && data.extraUsage !== null && data.extraUsage.isEnabled ? (
        <ClaudeExtraUsageRow extraUsage={data.extraUsage} />
      ) : null}
    </div>
  );
}

function ClaudeExtraUsageRow({
  extraUsage,
}: {
  readonly extraUsage: NonNullable<ClaudeRateLimits["extraUsage"]>;
}): ReactNode {
  // `monthlyLimit`/`usedCredits` give a ratio-based bar without depending on
  // the ambiguous 0-1-vs-0-100 scale of `utilization` (open item on the wire
  // contract - see the tech plan). `utilization` is only ever shown as raw
  // supplementary text.
  if (extraUsage.monthlyLimit !== null && extraUsage.usedCredits !== null) {
    const usedPercent =
      extraUsage.monthlyLimit > 0
        ? (extraUsage.usedCredits / extraUsage.monthlyLimit) * 100
        : 0;
    return (
      <UsageBar
        label="Extra usage"
        consumed={extraUsage.usedCredits}
        total={extraUsage.monthlyLimit}
        tone={usageBarTone(usedPercent)}
        formatValue={(value) => value.toFixed(2)}
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

/**
 * OpenRouter's usage detail: a request/credit bar when a hard `limit` exists,
 * plus its uncapped spend/credit/balance figures as plain neutral rows (Core
 * Flows: "Windows without a percentage" - no fabricated percentage, no severity
 * color). All figures are $-denominated OpenRouter credits.
 */
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

// Only OpenRouter's `limit`/`limitRemaining` pair yields a computable "% of
// limit"; the derived percentage matches the header glyph's exact
// `((limit - limitRemaining) / limit) * 100`, so the bar's fill/color tracks
// the same number. Absent a hard limit, no bar renders (the spend rows stand
// alone).
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
    <UsageBar
      label="Credits"
      consumed={consumed}
      total={limit}
      tone={usageBarTone(usedPercent)}
      formatValue={formatProviderCurrency}
    />
  );
}

/**
 * Kilo Code's usage detail: a credit balance and Kilo Pass state, both as plain
 * neutral rows. No computable percentage exists for Kilo Code, so it never
 * renders a bar (Core Flows: "Windows without a percentage").
 */
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

export function ProviderRateLimitBody(
  props: ProviderRateLimitQueryState,
): ReactNode {
  const state = resolveProviderRateLimitViewState(props);
  // `isPending` alone stays `true` forever for a disabled query (e.g. a chat
  // tab bound to an unreachable host, where `useHostQuery` never enables) -
  // `resolveProviderRateLimitViewState` also gates on `isFetching` so that
  // case falls through to the `empty` branch below instead of an eternal
  // spinner.
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading rate limits
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn't load rate limits. Try refreshing.
      </div>
    );
  }
  if (state.kind === "empty") return null;
  const data = state.data;
  if (!data.available) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        Rate limits unavailable — {formatUnavailableReason(data.reason)}
      </p>
    );
  }
  return <ProviderRateLimitDetail data={data} variant="settings" />;
}

/**
 * Renders one provider's available-arm detail. Exhaustive over every
 * `available: true` arm (`data.provider` is now four-way, not the old binary
 * codex/claude split), so a new provider arm added to the wire union fails the
 * build here until it gets a view. Exported so the header popover reuses the
 * exact same per-provider bodies the Settings card shows (Core Flows: "both
 * read the same underlying provider usage data, so they never disagree").
 */
export function ProviderRateLimitDetail({
  data,
  variant,
}: {
  readonly data: AvailableProviderRateLimits;
  readonly variant: RateLimitViewVariant;
}): ReactNode {
  switch (data.provider) {
    case "codex":
      return <CodexRateLimitView data={data} variant={variant} />;
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
  }
}
