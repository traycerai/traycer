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
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import { Badge } from "@/components/ui/badge";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  UsageBar,
  type UsageBarTone,
} from "@/components/settings/panels/traycer-subscription-section";
import { contextUsageTone } from "@/components/chat/context-usage";
import { resolveProviderRateLimitViewState } from "@/lib/provider-rate-limit-content";
import { formatResetDateTime, useResetCountdown } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

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

function formatUsagePercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Rate-limit severity scale: >70% used is a warning, >90% is critical - a
 * single source of truth for both the bar's fill color (`usageBarTone`) and
 * the adjacent percent/reset text color (`windowTone`), so a window's whole
 * row changes color together instead of the bar and its text drifting at
 * different thresholds. Distinct from the shared `contextUsageTone` (a
 * LEFT/remaining-percent scale for the unrelated context-window chip, with
 * its own thresholds) - rate limits report a USED percentage and warrant
 * their own scale.
 */
function rateLimitSeverity(usedPercent: number): UsageBarTone | null {
  if (usedPercent > 90) return "critical";
  if (usedPercent > 70) return "warning";
  return null;
}

function windowTone(severity: UsageBarTone | null): string {
  if (severity === "critical") return "text-destructive";
  if (severity === "warning") return "text-amber-500 dark:text-amber-400";
  return "text-muted-foreground";
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

/** A single window row: a labeled `UsageBar` plus its reset line. */
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
  const severity = rateLimitSeverity(window.usedPercent);
  const resetLine = (
    <ResetLine
      resetsAt={window.resetsAt}
      tone={windowTone(severity)}
      weekly={weekly}
    />
  );
  return (
    <div className="flex flex-col gap-1">
      <UsageBar
        label={label}
        consumed={window.usedPercent}
        total={100}
        tone={severity ?? undefined}
        formatValue={formatUsagePercent}
      />
      <div className="flex justify-end">{resetLine}</div>
    </div>
  );
}

const CODEX_WINDOW_LABELS = { primary: "5-hour", secondary: "Weekly" } as const;
const CLAUDE_WINDOW_LABELS = {
  fiveHour: "5-hour",
  sevenDay: "Weekly",
  sevenDayOpus: "Weekly (Opus)",
  sevenDaySonnet: "Weekly (Sonnet)",
} as const;

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
}: {
  readonly data: CodexRateLimits;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {data.rateLimitReachedType !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">
            {formatRateLimitReachedType(data.rateLimitReachedType)}
          </Badge>
        </div>
      ) : null}
      <RateLimitWindowRow
        label={CODEX_WINDOW_LABELS.primary}
        window={data.primary}
        weekly={false}
      />
      <RateLimitWindowRow
        label={CODEX_WINDOW_LABELS.secondary}
        window={data.secondary}
        weekly
      />
      {data.credits !== null ? (
        <CodexCreditsRow credits={data.credits} />
      ) : null}
      {data.individualLimit !== null ? (
        <CodexSpendControlRow limit={data.individualLimit} />
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
          weekly={false}
        />
      </div>
    </div>
  );
}

export function ClaudeRateLimitView({
  data,
}: {
  readonly data: ClaudeRateLimits;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.fiveHour}
        window={data.fiveHour}
        weekly={false}
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDay}
        window={data.sevenDay}
        weekly
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDayOpus}
        window={data.sevenDayOpus}
        weekly
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDaySonnet}
        window={data.sevenDaySonnet}
        weekly
      />
      {data.modelScoped.length > 0 ? (
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
              weekly
            />
          ))}
        </div>
      ) : null}
      {data.extraUsage !== null && data.extraUsage.isEnabled ? (
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

// Exhaustive set of `reason` codes the host emits (`provider-rate-limits.ts`,
// `rate-limits/{codex,claude}.ts`, `rate-limits/common.ts`) - the wire field
// is a machine identifier, not display copy. Falls back to a lowercased,
// space-joined rendering of any code not listed here.
// `Record<RateLimitUnavailableReason, string>` (not `Record<string, string>`)
// makes this exhaustive at compile time: adding a reason to the protocol's
// closed enum without adding a label here fails the build instead of
// silently falling through to a raw, underscore-joined reason code.
const RATE_LIMIT_UNAVAILABLE_REASON_LABELS: Record<
  RateLimitUnavailableReason,
  string
> = {
  cli_not_found: "the CLI isn't installed",
  unsupported_provider: "this provider isn't supported",
  invalid_response: "the CLI returned an unexpected response",
  timeout: "the request timed out",
  connection_failed: "couldn't connect to the CLI",
  sdk_incompatible: "this SDK version doesn't support rate limits",
  rate_limits_not_available: "not available for this account",
};

function formatUnavailableReason(reason: RateLimitUnavailableReason): string {
  return RATE_LIMIT_UNAVAILABLE_REASON_LABELS[reason];
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
  return <ProviderRateLimitDetail data={data} />;
}

function ProviderRateLimitDetail({
  data,
}: {
  readonly data: AvailableProviderRateLimits;
}): ReactNode {
  if (data.provider === "codex") {
    return <CodexRateLimitView data={data} />;
  }
  return <ClaudeRateLimitView data={data} />;
}
